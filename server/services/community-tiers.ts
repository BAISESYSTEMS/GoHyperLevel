import { createHmac } from 'node:crypto';
import type { App, LocationRow } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { centsToMoney, id, now, safeEqual, slugify } from '../core/util.js';
import { addTags, getContact, logActivity, removeTags, upsertContact, type Contact } from './contacts.js';
import { portalUrl, grantAccess, revokeAccess } from './courses.js';
import { joinGroup } from './community-actions.js';
import { groupSettings, levelFor, memberPoints, membershipGrants } from './community.js';
import { deliverEmail, type OutMail } from './messaging.js';
import { videoEmbed } from './markdown.js';

/**
 * Joining a community from its public page: the page (about text, join questions, approval), the tiers (free, monthly or
 * yearly, lifetime – each backed by an existing product), memberships with their life cycle (request → approval → payment
 * → trial → active → past due → ended) and the checks that decide who may enter. Payments themselves stay with Stripe and
 * the products: a membership starts when `product.purchased` arrives and ends with `product.subscription_ended`.
 */

export const QUESTION_MAX = 3;
export type Billing = 'free' | 'month' | 'year' | 'once';
export type MStatus = 'pending' | 'awaiting_payment' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'rejected';
/** Memberships that count as "dabei" in the numbers. */
export const LIVE_STATUSES: MStatus[] = ['trialing', 'active', 'past_due'];

export interface Question {
  id: string;
  label: string;
  required: boolean;
  /** Contact field the answer is stored in (custom field key). */
  field_key: string;
}

export interface PageRow {
  group_id: string;
  location_id: string;
  slug: string;
  enabled: number;
  discoverable: number;
  indexable: number;
  tagline: string;
  about: string;
  video_url: string;
  cover_image: string;
  seo_title: string;
  seo_description: string;
  questions: Question[];
  approval: number;
  terms_url: string;
  privacy_url: string;
  consent_text: string;
  success_text: string;
  show_admins: number;
  show_member_count: number;
  stripe_promo: number;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface Tier {
  id: string;
  location_id: string;
  group_id: string;
  name: string;
  description: string;
  position: number;
  product_id: string | null;
  annual_product_id: string | null;
  trial_days: number;
  features: string[];
  course_ids: string[];
  tags: string[];
  active: number;
  highlight: number;
  grace_days: number;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  id: string;
  location_id: string;
  group_id: string;
  contact_id: string;
  tier_id: string | null;
  status: MStatus;
  source: string;
  product_id: string | null;
  billing: Billing;
  subscription: string | null;
  answers: Record<string, string>;
  invite_id: string | null;
  coupon_code: string;
  consent: number;
  note: string;
  joined_at: string | null;
  requested_at: string;
  approved_at: string | null;
  approved_by: string;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  converted_at: string | null;
  past_due_at: string | null;
  cancel_at: string | null;
  canceled_at: string | null;
  left_reason: string;
  created_at: string;
  updated_at: string;
}

const PAGE_JSON = ['questions'];
const TIER_JSON = ['features', 'course_ids', 'tags'];

// --- signed links -----------------------------------------------------------------------------------------

/** A membership id that only the server could have signed – goes into the checkout link and the approval mail. */
export function signMembership(app: App, membershipId: string): string {
  return `${membershipId}.${createHmac('sha256', app.config.secret).update(`community-join:${membershipId}`).digest('hex').slice(0, 24)}`;
}

export function verifyMembership(app: App, tok: unknown): string | undefined {
  const [mid, sig] = String(tok ?? '').split('.');
  if (!mid || !sig || mid.length > 64) return undefined;
  return safeEqual(signMembership(app, mid), `${mid}.${sig}`) ? mid : undefined;
}

// --- page ---------------------------------------------------------------------------------------------------

export function pageOf(app: App, groupId: string): PageRow | undefined {
  return parseJson(app.db.get<PageRow>('SELECT * FROM community_pages WHERE group_id = ?', groupId), PAGE_JSON);
}

export function pageBySlug(app: App, slug: string): PageRow | undefined {
  return parseJson(app.db.get<PageRow>('SELECT * FROM community_pages WHERE slug = ?', String(slug ?? '').toLowerCase().slice(0, 80)), PAGE_JSON);
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const str = (v: unknown, max: number) => String(v ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

export const cleanHttps = (v: unknown, what: string, opts: { allowRelative?: boolean } = {}) => {
  const s = str(v, 1000);
  if (!s) return '';
  if (opts.allowRelative && /^\/[^\s/][^\s]*$/.test(s)) return s;
  if (!/^https:\/\/[^\s]+$/i.test(s)) throw bad(`${what}: bitte eine Adresse mit https:// angeben`);
  return s;
};

export function cleanQuestions(v: unknown, cur: Question[] = []): Question[] {
  if (v === undefined) return cur;
  if (!Array.isArray(v)) throw bad('Fragen: Liste erwartet');
  const out: Question[] = [];
  for (const raw of v) {
    const label = str(raw?.label, 150);
    if (!label) continue;
    if (out.length >= QUESTION_MAX) throw bad(`Höchstens ${QUESTION_MAX} Fragen`);
    const key = str(raw?.field_key, 60).toLowerCase().replace(/-/g, '_');
    if (key && !/^[a-z][a-z0-9_]{1,59}$/.test(key)) throw bad('Kontaktfeld: nur a–z, 0–9 und _');
    out.push({ id: str(raw?.id, 20).replace(/[^a-z0-9_-]/gi, '') || `q${out.length + 1}`, label, required: raw?.required === true || raw?.required === 1, field_key: key });
  }
  const seen = new Set<string>();
  for (const q of out) {
    while (seen.has(q.id)) q.id += 'x';
    seen.add(q.id);
  }
  return out;
}

/** Makes sure every question has a contact field to store its answer in (created in the sub-account on first use). */
export function ensureQuestionFields(app: App, locationId: string, questions: Question[]): Question[] {
  return questions.map((q) => {
    const key = q.field_key || `frage_${slugify(q.label).replace(/-/g, '_').slice(0, 40)}`;
    if (!app.db.get('SELECT id FROM custom_fields WHERE location_id = ? AND key = ?', locationId, key)) {
      app.db.insert('custom_fields', { id: id(), location_id: locationId, key, label: q.label.slice(0, 100), type: 'text', options: [], position: 0, created_at: now() });
    }
    return { ...q, field_key: key };
  });
}

/** Validates the page settings of the editor/API. `cur` is the stored page (undefined for a new one). */
export function cleanPage(app: App, g: { id: string; location_id: string; slug: string; name: string }, input: any, cur?: PageRow): Omit<PageRow, 'created_at' | 'updated_at'> {
  const b = input ?? {};
  let slug = cur?.slug ?? '';
  if (b.slug !== undefined || !cur) {
    slug = slugify(String(b.slug ?? g.slug ?? g.name));
    if (!SLUG.test(slug)) throw bad('Adresse: 3–50 Zeichen, a–z, 0–9 und -');
    if (['new', 'api', 'i', 'app'].includes(slug)) throw bad('Diese Adresse ist reserviert');
    const taken = app.db.get('SELECT group_id FROM community_pages WHERE slug = ? AND group_id != ?', slug, g.id);
    if (taken) throw bad('Diese Adresse ist schon vergeben – bitte eine andere wählen');
  }
  const pick = <K extends keyof PageRow>(k: K, fn: (v: unknown) => any, fallback: PageRow[K]) => (b[k] === undefined ? (cur?.[k] ?? fallback) : fn(b[k]));
  const video = b.video_url === undefined ? (cur?.video_url ?? '') : cleanHttps(b.video_url, 'Video');
  if (video && !videoEmbed(video)) throw bad('Video: YouTube, Vimeo, Loom oder eine direkte MP4-Datei (https://)');
  return {
    group_id: g.id,
    location_id: g.location_id,
    slug,
    enabled: pick('enabled', (v) => (v ? 1 : 0), 0),
    discoverable: pick('discoverable', (v) => (v ? 1 : 0), 0),
    indexable: pick('indexable', (v) => (v ? 1 : 0), 1),
    tagline: pick('tagline', (v) => str(v, 140), ''),
    about: pick('about', (v) => str(v, 20_000), ''),
    video_url: video,
    cover_image: b.cover_image === undefined ? (cur?.cover_image ?? '') : cleanHttps(b.cover_image, 'Titelbild', { allowRelative: true }),
    seo_title: pick('seo_title', (v) => str(v, 70), ''),
    seo_description: pick('seo_description', (v) => str(v, 160), ''),
    questions: cleanQuestions(b.questions, cur?.questions ?? []),
    approval: pick('approval', (v) => (v ? 1 : 0), 0),
    terms_url: b.terms_url === undefined ? (cur?.terms_url ?? '') : cleanHttps(b.terms_url, 'AGB-Link'),
    privacy_url: b.privacy_url === undefined ? (cur?.privacy_url ?? '') : cleanHttps(b.privacy_url, 'Datenschutz-Link'),
    consent_text: pick('consent_text', (v) => str(v, 300), ''),
    success_text: pick('success_text', (v) => str(v, 500), ''),
    show_admins: pick('show_admins', (v) => (v ? 1 : 0), 1),
    show_member_count: pick('show_member_count', (v) => (v ? 1 : 0), 1),
    stripe_promo: pick('stripe_promo', (v) => (v ? 1 : 0), 0),
    category: pick('category', (v) => str(v, 40), ''),
  };
}

// --- tiers & prices -------------------------------------------------------------------------------------------

export interface ProductInfo {
  id: string;
  name: string;
  currency: string;
  price_cents: number;
  gross_cents: number;
  tax: number;
  recurring: '' | 'month' | 'year';
  active: boolean;
  buy_key: string;
}

/** A product as the page and the checkout see it (price incl. tax like the buy page). */
export function productInfo(app: App, locationId: string, productId: string | null | undefined): ProductInfo | undefined {
  if (!productId) return undefined;
  const p = app.db.get<any>('SELECT * FROM products WHERE id = ? AND location_id = ?', productId, locationId);
  if (!p) return undefined;
  const sb = app.services.stripeBuy;
  const link = sb?.linkOf?.(p.id);
  let tax = 0;
  let gross = p.price_cents;
  if (sb?.grossOf) ({ tax, gross } = sb.grossOf(p));
  return {
    id: p.id,
    name: p.name,
    currency: String(p.currency || 'EUR').toUpperCase(),
    price_cents: p.price_cents,
    gross_cents: gross,
    tax,
    recurring: p.recurring === 'month' || p.recurring === 'year' ? p.recurring : '',
    active: !!p.active && !(link && !link.enabled),
    buy_key: link?.slug || p.id,
  };
}

export interface TierPrices {
  free: boolean;
  month?: ProductInfo;
  year?: ProductInfo;
  once?: ProductInfo;
}

/** Which billing options a tier offers, from its products. */
export function tierPrices(app: App, t: Pick<Tier, 'location_id' | 'product_id' | 'annual_product_id'>): TierPrices {
  const main = productInfo(app, t.location_id, t.product_id);
  const annual = productInfo(app, t.location_id, t.annual_product_id);
  if (!main && !annual) return { free: true };
  const out: TierPrices = { free: false };
  for (const p of [main, annual]) {
    if (!p) continue;
    if (p.recurring === 'month') out.month ??= p;
    else if (p.recurring === 'year') out.year ??= p;
    else out.once ??= p;
  }
  return out;
}

export const billingsOf = (p: TierPrices): Billing[] => (p.free ? ['free'] : (['month', 'year', 'once'] as const).filter((b) => !!p[b]));

/** Net value per month in cents (yearly ÷ 12, lifetime = 0 for MRR). */
export function monthlyValue(app: App, t: Pick<Tier, 'location_id' | 'product_id' | 'annual_product_id'>, billing: Billing): number {
  const p = tierPrices(app, t);
  if (billing === 'month') return p.month?.price_cents ?? 0;
  if (billing === 'year') return Math.round((p.year?.price_cents ?? 0) / 12);
  return 0;
}

/** "19,00 € / Monat" style text. */
export function priceText(p: ProductInfo): string {
  return `${centsToMoney(p.gross_cents, p.currency)}${p.recurring === 'month' ? ' / Monat' : p.recurring === 'year' ? ' / Jahr' : ' einmalig'}`;
}

export function tiersOf(app: App, groupId: string, activeOnly = false): Tier[] {
  return parseRows(app.db.all<Tier>(`SELECT * FROM community_tiers WHERE group_id = ?${activeOnly ? ' AND active = 1' : ''} ORDER BY position, created_at`, groupId), TIER_JSON);
}

export function tierOf(app: App, groupId: string, tierId: string | null | undefined): Tier | undefined {
  return tierId ? parseJson(app.db.get<Tier>('SELECT * FROM community_tiers WHERE id = ? AND group_id = ?', tierId, groupId), TIER_JSON) : undefined;
}

const list = (v: unknown, max: number, len: number) => (Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : []);

export function cleanTier(app: App, locationId: string, input: any, cur?: Tier) {
  const b = input ?? {};
  const out: Record<string, any> = {};
  if (b.name !== undefined || !cur) {
    const name = str(b.name, 60);
    if (!name) throw bad('Name der Stufe fehlt');
    out.name = name;
  }
  if (b.description !== undefined) out.description = str(b.description, 500);
  if (b.features !== undefined) out.features = list(b.features, 8, 100);
  if (b.tags !== undefined) out.tags = list(b.tags, 10, 60);
  if (b.course_ids !== undefined) {
    const ids = list(b.course_ids, 20, 40);
    for (const cid of ids) if (!app.db.get('SELECT id FROM courses WHERE id = ? AND location_id = ?', cid, locationId)) throw bad('Kurs nicht gefunden');
    out.course_ids = ids;
  }
  for (const k of ['active', 'highlight'] as const) if (b[k] !== undefined) out[k] = b[k] ? 1 : 0;
  if (b.position !== undefined) out.position = Math.max(0, Math.round(Number(b.position) || 0));
  if (b.grace_days !== undefined) out.grace_days = Math.min(Math.max(Math.round(Number(b.grace_days) || 0), 0), 30);
  const productId = b.product_id === undefined ? (cur?.product_id ?? null) : b.product_id || null;
  const annualId = b.annual_product_id === undefined ? (cur?.annual_product_id ?? null) : b.annual_product_id || null;
  for (const [pid, what] of [[productId, 'Produkt'], [annualId, 'Jahres-Produkt']] as const) {
    if (pid && !app.db.get('SELECT id FROM products WHERE id = ? AND location_id = ?', pid, locationId)) throw bad(`${what} nicht gefunden`);
  }
  const main = productInfo(app, locationId, productId);
  const annual = productInfo(app, locationId, annualId);
  if (productId && main && main.price_cents <= 0) throw bad('Das Produkt braucht einen Preis über 0 – kostenlose Stufen haben kein Produkt');
  if (annualId) {
    if (!productId) throw bad('Das Jahres-Produkt braucht zusätzlich ein Monats-Produkt');
    if (annual?.recurring !== 'year') throw bad('Jahres-Produkt: bitte ein Produkt mit „jährlich“ als Zahlungsweise wählen');
    if (main?.recurring !== 'month') throw bad('Monats-Produkt: bitte ein Produkt mit „monatlich“ als Zahlungsweise wählen (oder das Jahres-Produkt weglassen)');
  }
  out.product_id = productId;
  out.annual_product_id = annualId;
  if (b.trial_days !== undefined || (!cur && productId)) {
    const days = Math.min(Math.max(Math.round(Number(b.trial_days) || 0), 0), 90);
    if (days && !(main?.recurring || annual?.recurring)) throw bad('Eine Testphase gibt es nur bei monatlicher oder jährlicher Zahlung');
    out.trial_days = days;
  }
  return out;
}

// --- memberships ----------------------------------------------------------------------------------------------

export function membershipOf(app: App, groupId: string, contactId: string): Membership | undefined {
  return parseJson(app.db.get<Membership>('SELECT * FROM community_memberships WHERE group_id = ? AND contact_id = ?', groupId, contactId), ['answers']);
}

export function membershipById(app: App, locationId: string, mid: string): Membership | undefined {
  return parseJson(app.db.get<Membership>('SELECT * FROM community_memberships WHERE id = ? AND location_id = ?', mid, locationId), ['answers']);
}

/** Does this membership let the person in right now (a past-due one only within the tier's grace days). */
export const grants = (app: App, m: Pick<Membership, 'status' | 'past_due_at' | 'tier_id' | 'cancel_at'> | undefined, at = Date.now()): boolean => membershipGrants(app, m, at);

export const hasMembership = (app: App, groupId: string, contactId: string) => grants(app, membershipOf(app, groupId, contactId));

/** Members in the numbers: everybody inside (not banned). */
export function memberCount(app: App, groupId: string): number {
  return app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM community_members WHERE group_id = ? AND banned_at IS NULL', groupId)!.n;
}

// --- mail --------------------------------------------------------------------------------------------------------------

export function brandOf(loc: LocationRow) {
  const b = loc.settings?.branding ?? {};
  return { name: String(b.name || loc.name), color: /^#[0-9a-f]{6}$/i.test(String(b.color ?? '')) ? String(b.color) : '#2563eb' };
}

/** A short transactional mail in the brand colour; `communityMailer` replaces the sender in tests. */
export async function communityMail(app: App, locationId: string, to: string, subject: string, paragraphs: string[], button?: { label: string; url: string }): Promise<boolean> {
  const loc = app.location(locationId);
  if (!loc || !to) return false;
  const brand = brandOf(loc);
  const text = `${paragraphs.join('\n\n')}${button ? `\n\n${button.label}: ${button.url}` : ''}\n\n${brand.name}`;
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;font-family:Arial,sans-serif;color:#0f172a"><div style="max-width:540px;margin:0 auto;padding:28px 18px"><div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:26px">
<h2 style="margin:0 0 14px;font-size:20px">${escapeHtml(subject)}</h2>
${paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')}
${button ? `<p style="margin:20px 0 0"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:${brand.color};color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:10px">${escapeHtml(button.label)}</a></p>` : ''}
</div><p style="font-size:12px;color:#94a3b8;text-align:center">${escapeHtml(brand.name)}</p></div></body></html>`;
  const mail: OutMail = { to, subject, text, html };
  try {
    await (app.services.communityMailer ?? deliverEmail)(loc, mail);
    return true;
  } catch (e) {
    console.error('[community] mail', (e as Error).message);
    return false;
  }
}

/** Tells the team (the sub-account's address) – join requests, failed payments. */
export async function notifyStaff(app: App, locationId: string, subject: string, body: string) {
  const loc = app.location(locationId);
  if (!loc?.email) return;
  try {
    await (app.services.communityMailer ?? deliverEmail)(loc, { to: loc.email, subject, text: body, html: `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>` });
  } catch (e) {
    console.error('[community] staff mail', (e as Error).message);
  }
}

// --- life cycle ----------------------------------------------------------------------------------------------------------

type G = { id: string; location_id: string; name: string; slug: string; settings?: any; access?: any };

const memberTag = (g: G, page?: PageRow) => `community:${page?.slug ?? g.slug}`;
const tierTag = (t: Tier) => `stufe:${slugify(t.name)}`;
const refOf = (t: Tier | undefined) => `tier:${t?.id ?? ''}`;

function log(app: App, g: G, contactId: string, type: string, text: string) {
  logActivity(app, g.location_id, contactId, type, text);
}

/** Creates the membership row of a request, or takes an existing one that is over (canceled/rejected) back into the queue. */
export function openMembership(app: App, g: G, contact: Contact, fields: Partial<Membership> & { tier_id: string | null }): Membership {
  const cur = membershipOf(app, g.id, contact.id);
  const base = {
    tier_id: fields.tier_id,
    source: fields.source ?? 'join',
    product_id: fields.product_id ?? null,
    billing: (fields.billing ?? 'free') as Billing,
    answers: fields.answers ?? {},
    invite_id: fields.invite_id ?? null,
    coupon_code: fields.coupon_code ?? '',
    consent: fields.consent ?? 0,
    status: (fields.status ?? 'pending') as MStatus,
    updated_at: now(),
  };
  if (!cur) {
    const row = { id: id(), location_id: g.location_id, group_id: g.id, contact_id: contact.id, requested_at: now(), created_at: now(), note: '', left_reason: '', approved_by: '', ...base };
    app.db.insert('community_memberships', row);
    return membershipOf(app, g.id, contact.id)!;
  }
  app.db.update('community_memberships', cur.id, { ...base, requested_at: now(), canceled_at: null, cancel_at: null, past_due_at: null, left_reason: '', approved_at: null });
  return membershipOf(app, g.id, contact.id)!;
}

/**
 * The person is in: row in the group (first visit = member_joined), profile, tags, courses of the tier, welcome automation
 * (it listens to community.member_joined). `trial` marks the start of a free trial. Idempotent.
 */
export function activateMembership(app: App, g: G, m: Membership, opts: { trial?: { ends_at: string }; by?: string; subscription?: string | null; quiet?: boolean } = {}): Membership {
  const contact = getContact(app, g.location_id, m.contact_id);
  if (!contact) throw new HttpError(404, 'Kontakt nicht gefunden');
  const ban = app.db.get<{ banned_at: string | null }>('SELECT banned_at FROM community_members WHERE group_id = ? AND contact_id = ?', g.id, contact.id);
  if (ban?.banned_at) throw new HttpError(403, 'Dieses Mitglied ist gesperrt');
  const was: MStatus = m.status;
  const wasWaiting = was === 'pending' || was === 'awaiting_payment';
  const trialing = !!opts.trial;
  const status: MStatus = trialing ? 'trialing' : 'active';
  const patch: Record<string, any> = { status, updated_at: now(), past_due_at: null, canceled_at: null, left_reason: '' };
  if (!m.joined_at) patch.joined_at = now();
  if (!m.approved_at) patch.approved_at = now();
  if (opts.by) patch.approved_by = opts.by;
  if (opts.subscription) patch.subscription = opts.subscription;
  if (trialing) Object.assign(patch, { trial_started_at: m.trial_started_at ?? now(), trial_ends_at: opts.trial!.ends_at });
  // An invite counts when somebody is really in, not when a form was sent.
  if (!m.joined_at && m.invite_id) app.db.run('UPDATE community_invites SET uses = uses + 1 WHERE id = ?', m.invite_id);
  app.db.update('community_memberships', m.id, patch);
  const next = membershipOf(app, g.id, contact.id)!;
  const page = pageOf(app, g.id);
  const tier = tierOf(app, g.id, next.tier_id);
  // The group row (first time: the event for workflows and the welcome automation).
  const first = joinGroup(app, g, contact);
  if (first) {
    // Somebody who comes back keeps their original "member since" and their level.
    const gg = app.db.get<any>('SELECT * FROM community_groups WHERE id = ?', g.id);
    const lvl = levelFor(memberPoints(app, g.id, contact.id), groupSettings(parseJson(gg, ['settings', 'access'])).levels);
    app.db.run('UPDATE community_members SET level = MAX(level, ?), joined_at = ? WHERE group_id = ? AND contact_id = ?', lvl, next.joined_at ?? now(), g.id, contact.id);
  }
  if (!opts.quiet) {
    addTags(app, g.location_id, contact.id, ['community', memberTag(g, page), ...(tier ? [tierTag(tier), ...tier.tags] : [])]);
    for (const cid of tier?.course_ids ?? []) {
      try {
        grantAccess(app, g.location_id, cid, contact.id, 'community', refOf(tier));
      } catch (e) {
        console.error('[community] tier course', (e as Error).message);
      }
    }
  }
  if (wasWaiting || (was as string) !== status) {
    log(app, g, contact.id, trialing ? 'community.trial_started' : 'community.activated', trialing ? `Testphase in „${g.name}“ gestartet (Stufe ${tier?.name ?? '–'})` : `Mitglied von „${g.name}“ (Stufe ${tier?.name ?? '–'})`);
  }
  if (trialing && was !== 'trialing') {
    app.events.emit(g.location_id, 'community.trial_started', { contactId: contact.id, groupId: g.id, group: { id: g.id, name: g.name }, tier: tier ? { id: tier.id, name: tier.name } : null, trial_ends_at: opts.trial!.ends_at });
  }
  return next;
}

/** Access ends (canceled subscription, failed payment, removed, left): out of the group, tier courses revoked, event. */
export function endMembership(app: App, g: G, m: Membership, reason: string, opts: { by?: string } = {}): Membership {
  const contact = getContact(app, g.location_id, m.contact_id);
  const live = m.status === 'active' || m.status === 'trialing' || m.status === 'past_due';
  app.db.update('community_memberships', m.id, { status: 'canceled', canceled_at: now(), cancel_at: null, left_reason: reason.slice(0, 80), updated_at: now() });
  const next = membershipOf(app, g.id, m.contact_id)!;
  if (!contact) return next;
  const page = pageOf(app, g.id);
  const tier = tierOf(app, g.id, m.tier_id);
  // Bans stay: a banned member's row is the ban.
  app.db.run('DELETE FROM community_members WHERE group_id = ? AND contact_id = ? AND banned_at IS NULL', g.id, contact.id);
  for (const cid of tier?.course_ids ?? []) {
    const e = app.db.get<{ source: string; source_ref: string }>('SELECT source, source_ref FROM course_enrollments WHERE course_id = ? AND contact_id = ? AND status = ?', cid, contact.id, 'active');
    if (e?.source === 'community' && e.source_ref === refOf(tier)) revokeAccess(app, g.location_id, cid, contact.id, `Community „${g.name}“ verlassen`);
  }
  removeTags(app, g.location_id, contact.id, [memberTag(g, page), ...(tier ? [tierTag(tier)] : [])]);
  if (live) {
    log(app, g, contact.id, 'community.left', `Community „${g.name}“ verlassen (${reason}${opts.by ? `, ${opts.by}` : ''})`);
    app.events.emit(g.location_id, 'community.member_left', { contactId: contact.id, groupId: g.id, group: { id: g.id, name: g.name }, tier: tier ? { id: tier.id, name: tier.name } : null, reason });
  }
  return next;
}

/** Payment failed: with grace days access goes on until they are over, without it it stops now. */
export function markPastDue(app: App, g: G, m: Membership): Membership {
  if (m.status === 'past_due' || m.status === 'canceled') return m;
  app.db.update('community_memberships', m.id, { status: 'past_due', past_due_at: now(), updated_at: now() });
  const next = membershipOf(app, g.id, m.contact_id)!;
  log(app, g, m.contact_id, 'community.past_due', `Zahlung für „${g.name}“ fehlgeschlagen`);
  if (!grants(app, next)) return endMembership(app, g, next, 'payment_failed');
  return next;
}

/** First real payment after a trial. */
export function markConverted(app: App, g: G, m: Membership): Membership {
  if (m.status === 'canceled') return m;
  const wasTrial = m.status === 'trialing';
  app.db.update('community_memberships', m.id, { status: 'active', converted_at: wasTrial ? now() : m.converted_at, past_due_at: null, updated_at: now() });
  const next = membershipOf(app, g.id, m.contact_id)!;
  if (wasTrial) {
    log(app, g, m.contact_id, 'community.trial_converted', `Testphase in „${g.name}“ wurde zur bezahlten Mitgliedschaft`);
    app.events.emit(g.location_id, 'community.trial_converted', { contactId: m.contact_id, groupId: g.id, group: { id: g.id, name: g.name }, tier: tierOf(app, g.id, m.tier_id) ? { id: m.tier_id, name: tierOf(app, g.id, m.tier_id)!.name } : null });
  }
  return next;
}

export function rejectMembership(app: App, g: G, m: Membership, by = '', note = ''): Membership {
  app.db.update('community_memberships', m.id, { status: 'rejected', note: note.slice(0, 300), approved_by: by, canceled_at: now(), updated_at: now() });
  log(app, g, m.contact_id, 'community.rejected', `Beitrittsanfrage für „${g.name}“ abgelehnt`);
  return membershipOf(app, g.id, m.contact_id)!;
}

/** The link the person pays at: the product's buy page with the signed membership id. */
export function checkoutUrl(app: App, m: Membership, billing: Billing = m.billing): string | undefined {
  const tier = tierOf(app, m.group_id, m.tier_id);
  if (!tier) return undefined;
  const prices = tierPrices(app, tier);
  const p = billing === 'free' ? undefined : prices[billing];
  if (!p) return undefined;
  const contact = getContact(app, m.location_id, m.contact_id);
  const qs = new URLSearchParams({ cm: signMembership(app, m.id), ...(contact?.email ? { email: contact.email } : {}) });
  return `${app.baseUrl()}/buy/${encodeURIComponent(p.buy_key)}?${qs}`;
}

/** Where a member finds the community. */
export const portalCommunityUrl = (app: App, g: { location_id: string; slug: string }) => `${portalUrl(app, g.location_id)}/community/g/${encodeURIComponent(g.slug)}`;

/** Approving a request: free tiers are in at once, paid ones get the checkout link by mail. */
export async function approveMembership(app: App, g: G, m: Membership, by = ''): Promise<Membership> {
  if (m.status !== 'pending') throw bad('Diese Anfrage ist nicht mehr offen');
  const tier = tierOf(app, g.id, m.tier_id);
  const prices = tier ? tierPrices(app, tier) : ({ free: true } as TierPrices);
  const contact = getContact(app, g.location_id, m.contact_id);
  if (prices.free || m.billing === 'free') {
    const next = activateMembership(app, g, m, { by });
    if (contact?.email) {
      void app.services.sendMemberLoginLink?.(g.location_id, contact.id)?.catch((e: Error) => console.error('[community] login link', e.message));
      await communityMail(app, g.location_id, contact.email, `Willkommen in „${g.name}“`, [`Dein Beitritt zu „${g.name}“ wurde freigegeben.`, 'Du bekommst gleich eine zweite E-Mail mit deinem Login-Link.']);
    }
    return next;
  }
  app.db.update('community_memberships', m.id, { status: 'awaiting_payment', approved_at: now(), approved_by: by, updated_at: now() });
  const next = membershipOf(app, g.id, m.contact_id)!;
  const url = checkoutUrl(app, next);
  if (contact?.email && url) {
    await communityMail(app, g.location_id, contact.email, `Dein Beitritt zu „${g.name}“ ist freigegeben`, [`Gute Nachricht: Wir haben deine Anfrage für „${g.name}“ angenommen.`, 'Schließe den Beitritt jetzt mit der Zahlung ab:'], { label: 'Beitritt abschließen', url });
  }
  log(app, g, m.contact_id, 'community.approved', `Beitrittsanfrage für „${g.name}“ angenommen`);
  return next;
}

// --- finding things from payment events ------------------------------------------------------------------------------------

/** Tiers (with their groups) that sell this product. */
export function tiersForProduct(app: App, locationId: string, productId: string): (Tier & { group: G })[] {
  const rows = parseRows(app.db.all<Tier>('SELECT * FROM community_tiers WHERE location_id = ? AND (product_id = ? OR annual_product_id = ?)', locationId, productId, productId), TIER_JSON);
  const out: (Tier & { group: G })[] = [];
  for (const t of rows) {
    const group = parseJson(app.db.get<any>('SELECT * FROM community_groups WHERE id = ? AND location_id = ?', t.group_id, locationId), ['settings', 'access']);
    if (group) out.push({ ...t, group });
  }
  return out;
}

export type { Contact };
export { upsertContact };
