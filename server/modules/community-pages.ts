import { createHmac } from 'node:crypto';
import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { HttpError, bad, notFound, redirect, text, type Ctx } from '../core/http.js';
import { id, normalizeEmail, now, safeEqual } from '../core/util.js';
import { centsToMoney } from '../core/util.js';
import { getContact, upsertContact } from '../services/contacts.js';
import { portalUrl } from '../services/courses.js';
import { getGroup, cleanGroupAccess } from '../services/community.js';
import { fileResponse } from '../services/community-actions.js';
import {
  cleanCoupon,
  cleanInvite,
  INVITE_HELD,
  holdForCheckout,
  inviteFull,
  joinCommunity,
  newInviteCode,
  sendWelcome,
  stripeCouponId,
  usableCoupon,
  usableInvite,
  couponLabel,
  type Coupon,
  type Invite,
} from '../services/community-join.js';
import { aboutHtml, discoverHtml, joinHtml, layout, noticeHtml, publicBrand, type DiscoverItem, type TierView } from '../services/community-public.js';
import {
  LIVE_STATUSES,
  activateMembership,
  approveMembership,
  cleanPage,
  cleanTier,
  communityMail,
  endMembership,
  ensureQuestionFields,
  grants,
  markConverted,
  markPastDue,
  memberCount,
  membershipById,
  membershipOf,
  openMembership,
  pageBySlug,
  pageOf,
  priceText,
  productInfo,
  rejectMembership,
  signMembership,
  tierOf,
  tierPrices,
  tiersForProduct,
  tiersOf,
  verifyMembership,
  billingsOf,
  type Billing,
  type Membership,
  type PageRow,
  type Tier,
} from '../services/community-tiers.js';
import { escapeHtml } from '../core/template.js';

/**
 * Joining a community from its public page. /c/<slug> is the About page (cover or video, description, price, admins, SEO tags),
 * /c/<slug>/join the form (name, e-mail, up to three questions, tier, discount code), /communities lists the open ones.
 * Free communities let people in at once or after approval; paid tiers send people to the checkout of their product (monthly,
 * yearly or lifetime, with free trial days and discount codes through the buy hooks of the Stripe module) and take them in when
 * `product.purchased` arrives – and out again when the subscription ends or a payment fails.
 */

const JOIN_JS = `(function(){
var f=document.querySelector('form.join');if(!f)return;
function sync(){var t=f.querySelector('input[name=tier]:checked')||f.querySelector('input[name=tier]');var id=t&&t.value;
f.querySelectorAll('[data-billing] label.opt').forEach(function(l){var show=!l.getAttribute('data-tier')||l.getAttribute('data-tier')===id;l.hidden=!show;
var i=l.querySelector('input');if(i)i.disabled=!show});
var vis=f.querySelectorAll('[data-billing] label.opt:not([hidden]) input');if(vis.length&&![].some.call(vis,function(i){return i.checked}))vis[0].checked=true;
var fs=f.querySelector('fieldset[data-billing]');if(fs)fs.hidden=!vis.length||vis.length<2}
f.querySelectorAll('input[name=tier]').forEach(function(i){i.addEventListener('change',sync)});sync();
var c=f.querySelector('input[name=coupon]');if(c){var msg=f.querySelector('[data-coupon-msg]'),t;
c.addEventListener('input',function(){clearTimeout(t);msg.textContent='';var v=c.value.trim();if(!v)return;
t=setTimeout(function(){var tier=(f.querySelector('input[name=tier]:checked')||f.querySelector('input[name=tier]')||{}).value||'';
fetch(c.getAttribute('data-coupon-url')+'?code='+encodeURIComponent(v)+'&tier='+encodeURIComponent(tier)).then(function(r){return r.json()}).then(function(j){
msg.style.color=j.ok?'#059669':'#dc2626';msg.textContent=j.ok?'✓ '+j.label:(j.error||'Code ungültig')}).catch(function(){})},400)})}
})();`;

type G = { id: string; location_id: string; name: string; slug: string; description: string; cover_image: string; status: string; access: any; settings: any };

/** Small in-memory throttles for the public forms (per IP and per address). */
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number): boolean {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (hits.size > 30_000) hits.clear();
  return list.length > max;
}

/** Per-hour limits of the public forms; tests lower or raise them through app.services.communityLimits. */
const LIMIT_DEFAULTS = { join: 30, coupon: 40 };

const sameOrigin = (ctx: Ctx) => {
  const o = ctx.req.headers.origin;
  if (ctx.req.headers['sec-fetch-site'] === 'same-origin') return true;
  if (!o || o === 'null') return !o;
  try {
    return new URL(String(o)).host === String(ctx.req.headers.host ?? '');
  } catch {
    return false;
  }
};

export const communityPagesModule: Module = {
  name: 'community-pages',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE community_pages (
        group_id TEXT PRIMARY KEY REFERENCES community_groups(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 0, discoverable INTEGER NOT NULL DEFAULT 0, indexable INTEGER NOT NULL DEFAULT 1,
        tagline TEXT NOT NULL DEFAULT '', about TEXT NOT NULL DEFAULT '', video_url TEXT NOT NULL DEFAULT '', cover_image TEXT NOT NULL DEFAULT '',
        seo_title TEXT NOT NULL DEFAULT '', seo_description TEXT NOT NULL DEFAULT '', questions TEXT NOT NULL DEFAULT '[]',
        approval INTEGER NOT NULL DEFAULT 0, terms_url TEXT NOT NULL DEFAULT '', privacy_url TEXT NOT NULL DEFAULT '', consent_text TEXT NOT NULL DEFAULT '',
        success_text TEXT NOT NULL DEFAULT '', show_admins INTEGER NOT NULL DEFAULT 1, show_member_count INTEGER NOT NULL DEFAULT 1,
        stripe_promo INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_pages_discover ON community_pages(enabled, discoverable);
      CREATE TABLE community_tiers (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0,
        product_id TEXT REFERENCES products(id) ON DELETE SET NULL, annual_product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
        trial_days INTEGER NOT NULL DEFAULT 0, features TEXT NOT NULL DEFAULT '[]', course_ids TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1, highlight INTEGER NOT NULL DEFAULT 0, grace_days INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX community_tiers_group ON community_tiers(group_id, position);
      CREATE TABLE community_memberships (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        tier_id TEXT REFERENCES community_tiers(id) ON DELETE SET NULL,
        status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'join', product_id TEXT, billing TEXT NOT NULL DEFAULT 'free', subscription TEXT,
        answers TEXT NOT NULL DEFAULT '{}', invite_id TEXT, coupon_code TEXT NOT NULL DEFAULT '', consent INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
        joined_at TEXT, requested_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT NOT NULL DEFAULT '',
        trial_started_at TEXT, trial_ends_at TEXT, converted_at TEXT, past_due_at TEXT, cancel_at TEXT, canceled_at TEXT, left_reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (group_id, contact_id)
      );
      CREATE INDEX community_memberships_group ON community_memberships(group_id, status);
      CREATE INDEX community_memberships_loc ON community_memberships(location_id, status);
      CREATE INDEX community_memberships_sub ON community_memberships(subscription);
      CREATE TABLE community_invites (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        code TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', tier_id TEXT REFERENCES community_tiers(id) ON DELETE SET NULL,
        skip_approval INTEGER NOT NULL DEFAULT 0, trial_days INTEGER, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
        active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE (group_id, code)
      );
      CREATE TABLE community_coupons (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        code TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', percent_off INTEGER, amount_off_cents INTEGER, duration TEXT NOT NULL DEFAULT 'once', months INTEGER,
        max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT, tier_id TEXT REFERENCES community_tiers(id) ON DELETE SET NULL,
        active INTEGER NOT NULL DEFAULT 1, stripe_coupon_id TEXT, created_at TEXT NOT NULL, UNIQUE (group_id, code)
      );
      CREATE TABLE community_channel_rules (
        channel_id TEXT PRIMARY KEY REFERENCES community_channels(id) ON DELETE CASCADE,
        group_id TEXT NOT NULL REFERENCES community_groups(id) ON DELETE CASCADE,
        min_level INTEGER NOT NULL DEFAULT 1, tier_ids TEXT NOT NULL DEFAULT '[]'
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const abs = (p: string) => `${app.baseUrl()}${p}`;

    // --- helpers ---------------------------------------------------------------------------------------------------------
    const mustGroup = (loc: string, gid: string) => {
      const g = getGroup(app, loc, gid);
      if (!g) throw notFound('Gruppe nicht gefunden');
      return g as G;
    };
    const actor = (ctx: Ctx) => ctx.user?.name || (ctx.via ?? 'api');
    const tierView = (t: Tier): TierView => ({ tier: t, prices: tierPrices(app, t) });
    const tierOut = (t: Tier) => {
      const p = tierPrices(app, t);
      const members = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE tier_id = ? AND status IN ('active','trialing','past_due')`, t.id)!.n;
      const bill = (x?: ReturnType<typeof productInfo>) => (x ? { product_id: x.id, name: x.name, price_cents: x.price_cents, gross_cents: x.gross_cents, currency: x.currency, text: priceText(x), active: x.active } : null);
      return { ...t, prices: { free: p.free, month: bill(p.month), year: bill(p.year), once: bill(p.once) }, billings: billingsOf(p), members };
    };
    const joinUrlOf = (page: PageRow) => abs(`/c/${encodeURIComponent(page.slug)}`);

    /** The public page of a slug – only when it is on and the group is active. */
    const findPublic = (slug: string) => {
      const page = pageBySlug(app, slug);
      if (!page || !page.enabled) return undefined;
      const g = parseJson(db.get<any>('SELECT * FROM community_groups WHERE id = ? AND status = ?', page.group_id, 'active'), ['access', 'settings']) as G | undefined;
      const loc = g && app.location(g.location_id);
      return g && loc ? { page, g, loc } : undefined;
    };
    const missing = () => {
      const r = layout(app, { id: '', name: 'Community', timezone: '', settings: {} } as any, { title: 'Nicht gefunden', robots: 'noindex, nofollow', status: 404, body: '<div class="center panel"><h1 style="font-size:28px">Nicht gefunden</h1><p class="muted">Diese Community gibt es nicht (mehr).</p><p><a class="btn" href="/communities">Alle Communities</a></p></div>' });
      return r;
    };

    const adminsOf = (g: G) =>
      db
        .all<any>(
          `SELECT r.contact_id, p.display_name, p.avatar_file_id, e.headline FROM community_roles r
           LEFT JOIN community_profiles p ON p.location_id = r.location_id AND p.contact_id = r.contact_id
           LEFT JOIN community_profile_ext e ON e.location_id = r.location_id AND e.contact_id = r.contact_id
           WHERE r.group_id = ? AND r.role = 'admin' ORDER BY r.created_at LIMIT 6`,
          g.id,
        )
        .filter((r) => r.display_name)
        .map((r) => ({ name: r.display_name as string, avatar: r.avatar_file_id ? `/c/${encodeURIComponent(pageOf(app, g.id)?.slug ?? '')}/avatar/${encodeURIComponent(r.avatar_file_id)}` : '', headline: (r.headline as string) ?? '' }));

    // --- stripe hooks: the join page hands over to the product's buy page -------------------------------------------------
    const membershipFrom = (loc: string, tok: unknown): Membership | undefined => {
      const mid = verifyMembership(app, tok);
      return mid ? membershipById(app, loc, mid) : undefined;
    };

    app.services.buyPageHtml = [
      ...(app.services.buyPageHtml ?? []),
      (ctx: Ctx, p: any) => {
        const m = membershipFrom(p.location_id, ctx.query.get('cm'));
        const tier = m && tierOf(app, m.group_id, m.tier_id);
        if (!m || !tier || ![tier.product_id, tier.annual_product_id].includes(p.id)) return '';
        const g = getGroup(app, m.location_id, m.group_id);
        const trial = m.status === 'awaiting_payment' && tier.trial_days > 0 && p.recurring;
        return `<input type="hidden" name="_cm" value="${escapeHtml(signMembership(app, m.id))}"><div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:10px 12px;margin:0 0 14px;font-size:14px">Beitritt zu <strong>${escapeHtml(g?.name ?? '')}</strong> · ${escapeHtml(tier.name)}${trial ? ` · <strong>${tier.trial_days} Tage kostenlos testen</strong>, danach ${escapeHtml(centsToMoney(sb()?.grossOf(p).gross ?? p.price_cents, p.currency))} / ${p.recurring === 'year' ? 'Jahr' : 'Monat'}` : ''}${m.coupon_code ? ` · Code ${escapeHtml(m.coupon_code)}` : ''}</div>`;
      },
    ];
    const sb = () => app.services.stripeBuy;

    /** Trial days only once per person and community. */
    const trialUsed = (m: Membership) => !!m.trial_started_at || !!db.get(`SELECT 1 FROM community_memberships WHERE group_id = ? AND contact_id = ? AND trial_started_at IS NOT NULL`, m.group_id, m.contact_id);

    app.services.buyCheckout = [
      ...(app.services.buyCheckout ?? []),
      async (ctx: Ctx, { product, params, meta }: { product: any; params: Record<string, any>; meta: Record<string, any> }) => {
        if (!ctx.body?._cm) return;
        const mid = verifyMembership(app, ctx.body._cm);
        const m = mid ? membershipById(app, product.location_id, mid) : undefined;
        if (!m) throw bad('Dieser Beitrittslink ist ungültig oder abgelaufen – bitte starte den Beitritt noch einmal');
        const tier = tierOf(app, m.group_id, m.tier_id);
        if (!tier || ![tier.product_id, tier.annual_product_id].includes(product.id)) throw bad('Dieses Produkt gehört nicht zu der gewählten Mitgliedschaft');
        if (m.status === 'canceled' || m.status === 'rejected' || m.status === 'pending') throw bad('Dieser Beitritt ist nicht mehr offen');
        const billing: Billing = product.recurring === 'month' ? 'month' : product.recurring === 'year' ? 'year' : 'once';
        db.run('UPDATE community_memberships SET billing = ?, product_id = ?, updated_at = ? WHERE id = ?', billing, product.id, now(), m.id);
        Object.assign(meta, { community_membership: m.id, community_group: m.group_id, community_tier: tier.id });
        const invite = m.invite_id ? db.get<Invite>('SELECT * FROM community_invites WHERE id = ?', m.invite_id) : undefined;
        // A limited invite that this person has not used yet (it counts when they are in): its last use may have gone – or be paid
        // for by somebody else right now – since they joined. A request the team approved is let through: the team decided.
        const inviteToHold = invite?.max_uses && !m.joined_at ? invite : undefined;
        if (inviteToHold && !m.approved_at && inviteFull(app, inviteToHold, m.id)) {
          throw bad(inviteToHold.uses >= (inviteToHold.max_uses ?? 0) ? 'Dieser Einladungslink ist schon aufgebraucht – bitte tritt ohne ihn bei' : INVITE_HELD);
        }
        const days = invite?.trial_days ?? tier.trial_days;
        if (params.mode === 'subscription' && days > 0 && !trialUsed(m)) {
          params.subscription_data = { ...(params.subscription_data ?? {}), trial_period_days: days };
          meta.community_trial = String(days);
        }
        const page = pageOf(app, m.group_id);
        let coupon: Coupon | undefined;
        if (m.coupon_code) {
          const r = usableCoupon(app, m.group_id, m.coupon_code, tier.id, m.id);
          if ('error' in r) throw bad(r.error);
          coupon = r.coupon;
          meta.community_coupon = r.coupon.code;
        }
        // A limited invite or code is held from here on – before the Stripe calls take their time (see holdForCheckout).
        holdForCheckout(m, { invite: inviteToHold, coupon }, params, meta);
        if (coupon) {
          const prod = productInfo(app, product.location_id, product.id)!;
          params.discounts = [{ coupon: await stripeCouponId(app, product.location_id, coupon, prod.currency) }];
          delete params.allow_promotion_codes;
        } else if (page?.stripe_promo) params.allow_promotion_codes = true;
      },
    ];

    // The first invoice of a trial is a free one, labelled as such (real prices follow with the renewals).
    app.services.buyInvoiceItems = [
      ...(app.services.buyInvoiceItems ?? []),
      (_loc: string, session: any, items: any[]) => {
        if (!session?.metadata?.community_trial) return items;
        return items.map((it, i) => (i === 0 ? { ...it, name: `${it.name} (Testphase, ${session.metadata.community_trial} Tage kostenlos)`, price_cents: 0 } : it));
      },
    ];

    // After paying: back to the community page, not the generic thank-you.
    app.services.buyAfterPaid = [
      ...(app.services.buyAfterPaid ?? []),
      (_ctx: Ctx, { checkout }: { checkout: any }) => {
        const mid = checkout?.meta?.community_membership;
        const m = mid ? membershipById(app, checkout.location_id, String(mid)) : undefined;
        const page = m && pageOf(app, m.group_id);
        return m && page ? redirect(`/c/${encodeURIComponent(page.slug)}/willkommen?cm=${encodeURIComponent(signMembership(app, m.id))}`, 303) : undefined;
      },
    ];

    // --- payment events → memberships ------------------------------------------------------------------------------------------
    const groupOf = (m: { location_id: string; group_id: string }) => parseJson(db.get<any>('SELECT * FROM community_groups WHERE id = ?', m.group_id), ['settings', 'access']) as G | undefined;
    const subOfSession = (sessionId: unknown): string | null => (sessionId ? (db.get<{ subscription: string | null }>('SELECT subscription FROM stripe_checkouts WHERE id = ?', String(sessionId))?.subscription ?? null) : null);

    /** A product was bought: the membership (from the join page or – for products sold some other way – a new one) starts. */
    function settlePurchase(locationId: string, d: { contactId?: string | null; productId?: string; metadata?: Record<string, any>; sessionId?: string }) {
      const md = d.metadata ?? {};
      const subscription = subOfSession(d.sessionId);
      const targets: { m?: Membership; tier: Tier; g: G; contactId: string }[] = [];
      const mid = String(md.community_membership ?? '');
      const joined = mid ? membershipById(app, locationId, mid) : undefined;
      if (joined) {
        const tier = tierOf(app, joined.group_id, joined.tier_id);
        const g = groupOf(joined);
        if (tier && g) targets.push({ m: joined, tier, g, contactId: joined.contact_id });
      } else if (d.productId && d.contactId) {
        for (const t of tiersForProduct(app, locationId, d.productId)) targets.push({ m: membershipOf(app, t.group_id, d.contactId), tier: t, g: t.group as G, contactId: d.contactId });
      }
      for (const x of targets) {
        const contact = getContact(app, locationId, x.contactId);
        if (!contact) continue;
        const product = productInfo(app, locationId, d.productId);
        const billing: Billing = product?.recurring === 'month' ? 'month' : product?.recurring === 'year' ? 'year' : 'once';
        let m = x.m;
        // Already in (this purchase was settled before, or the person was a member another way): nothing to do.
        if (m && grants(app, m)) continue;
        if (!m || m.status === 'canceled' || m.status === 'rejected') m = openMembership(app, x.g, contact, { tier_id: x.tier.id, billing, product_id: d.productId ?? null, status: 'pending', source: 'purchase' });
        db.run('UPDATE community_memberships SET billing = ?, product_id = ?, coupon_code = CASE WHEN ? != \'\' THEN ? ELSE coupon_code END WHERE id = ?', billing, d.productId ?? null, String(md.community_coupon ?? ''), String(md.community_coupon ?? ''), m.id);
        const days = Number(md.community_trial);
        const fresh = membershipById(app, locationId, m.id)!;
        activateMembership(app, x.g, fresh, { subscription, trial: days > 0 ? { ends_at: new Date(Date.now() + days * 864e5).toISOString() } : undefined });
        if (md.community_coupon) db.run('UPDATE community_coupons SET uses = uses + 1 WHERE group_id = ? AND code = ?', x.g.id, String(md.community_coupon));
      }
      return targets.length;
    }
    app.events.on('product.purchased', (e) => {
      settlePurchase(e.locationId, { contactId: e.data.contactId, productId: e.data.productId, metadata: e.data.metadata, sessionId: e.data.sessionId });
    });

    /** Live memberships bought with this product (by subscription id when known, else by person and product). */
    const liveFor = (locationId: string, d: { contactId?: string | null; productId?: string; subscription?: string | null }): Membership[] => {
      const rows = parseRows(
        db.all<Membership>(
          `SELECT * FROM community_memberships WHERE location_id = ? AND status IN ('active','trialing','past_due') AND ((? != '' AND subscription = ?) OR (? != '' AND contact_id = ? AND product_id = ?))`,
          locationId,
          d.subscription ?? '',
          d.subscription ?? '',
          d.contactId ?? '',
          d.contactId ?? '',
          d.productId ?? '',
        ),
        ['answers'],
      );
      return rows;
    };
    app.events.on('product.subscription_ended', (e) => {
      for (const m of liveFor(e.locationId, { contactId: e.data.contactId, productId: e.data.productId, subscription: e.data.subscription })) {
        const g = groupOf(m);
        if (g) endMembership(app, g, m, 'subscription_ended');
      }
    });
    app.events.on('payment.failed', (e) => {
      for (const m of liveFor(e.locationId, { contactId: e.data.contactId, productId: e.data.productId, subscription: e.data.subscription })) {
        const g = groupOf(m);
        if (!g || m.billing === 'once') continue;
        markPastDue(app, g, m);
        void communityMail(app, e.locationId, getContact(app, e.locationId, m.contact_id)?.email ?? '', `Zahlung für „${g.name}“ fehlgeschlagen`, [`Deine letzte Zahlung für „${g.name}“ konnte nicht abgebucht werden.`, 'Bitte prüfe deine Zahlungsart, damit dein Zugang erhalten bleibt.']);
      }
    });
    app.events.on('invoice.paid', (e) => {
      if (e.data.via !== 'Stripe-Abo' || !e.data.invoice?.id) return;
      const row = db.get<{ product_id: string; contact_id: string; subscription: string }>(`SELECT product_id, contact_id, subscription FROM stripe_checkouts WHERE location_id = ? AND kind = 'renewal' AND invoice_id = ?`, e.locationId, e.data.invoice.id);
      if (!row) return;
      for (const m of liveFor(e.locationId, { contactId: row.contact_id, productId: row.product_id, subscription: row.subscription })) {
        const g = groupOf(m);
        if (g && (m.status === 'trialing' || m.status === 'past_due')) markConverted(app, g, m);
      }
    });
    app.events.on('payment.refunded', (e) => {
      if (!e.data.full || !e.data.productId) return;
      for (const m of liveFor(e.locationId, { contactId: e.data.contactId, productId: e.data.productId })) {
        const g = groupOf(m);
        if (g && m.billing === 'once') endMembership(app, g, m, 'refunded');
      }
    });

    // Past due beyond the grace days, and memberships set to end.
    app.onTick(() => {
      for (const m of parseRows(db.all<Membership>(`SELECT * FROM community_memberships WHERE status IN ('active','trialing','past_due')`), ['answers'])) {
        if (grants(app, m)) continue;
        const g = groupOf(m);
        if (g) endMembership(app, g, m, m.cancel_at ? 'canceled' : 'payment_failed');
      }
    });

    // --- admin API: page, tiers, requests -------------------------------------------------------------------------------------
    const pageOut = (g: G) => {
      const page = pageOf(app, g.id);
      return {
        page: page ?? null,
        url: page ? joinUrlOf(page) : null,
        access_mode: cleanGroupAccess(g.access).mode,
        tiers: tiersOf(app, g.id).map(tierOut),
        counts: Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM community_memberships WHERE group_id = ? GROUP BY status', g.id).map((r) => [r.status, r.n])),
        stripe: { connected: !!sb()?.secretKey?.(g.location_id) },
        products: db.all('SELECT id, name, price_cents, currency, recurring, active FROM products WHERE location_id = ? ORDER BY name', g.location_id),
        discovery_url: abs('/communities'),
      };
    };
    router.get('/api/community/groups/:id/join', 'location', (ctx) => pageOut(mustGroup(ctx.locationId, ctx.params.id)));

    const PAGE_KEYS = ['slug', 'enabled', 'discoverable', 'indexable', 'tagline', 'about', 'video_url', 'cover_image', 'seo_title', 'seo_description', 'questions', 'approval', 'terms_url', 'privacy_url', 'consent_text', 'success_text', 'show_admins', 'show_member_count', 'stripe_promo', 'category'];
    const savePage = (g: G, next: Record<string, any>) => {
      db.run(
        `INSERT INTO community_pages (group_id, location_id, ${PAGE_KEYS.join(', ')}, created_at, updated_at) VALUES (?, ?, ${PAGE_KEYS.map(() => '?').join(', ')}, ?, ?)
         ON CONFLICT(group_id) DO UPDATE SET ${PAGE_KEYS.map((k) => `${k} = excluded.${k}`).join(', ')}, updated_at = excluded.updated_at`,
        g.id,
        g.location_id,
        ...PAGE_KEYS.map((k) => (k === 'questions' ? JSON.stringify(next[k]) : next[k])),
        now(),
        now(),
      );
    };

    /** Groups that only let joined members in: everybody inside today keeps access as a free member. */
    function switchToJoinMode(g: G) {
      const tier = tiersOf(app, g.id).find((t) => !t.product_id && !t.annual_product_id) ?? tiersOf(app, g.id)[0];
      db.tx(() => {
        db.update('community_groups', g.id, { access: { ...cleanGroupAccess(g.access), mode: 'join' }, updated_at: now() });
        for (const m of db.all<{ contact_id: string; joined_at: string }>('SELECT contact_id, joined_at FROM community_members WHERE group_id = ? AND banned_at IS NULL', g.id)) {
          if (membershipOf(app, g.id, m.contact_id)) continue;
          db.insert('community_memberships', { id: id(), location_id: g.location_id, group_id: g.id, contact_id: m.contact_id, tier_id: tier?.id ?? null, status: 'active', source: 'migrated', billing: 'free', answers: {}, joined_at: m.joined_at, requested_at: m.joined_at, approved_at: now(), created_at: now(), updated_at: now() });
        }
      });
    }

    router.put('/api/community/groups/:id/join/page', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const cur = pageOf(app, g.id);
      const next = cleanPage(app, g, ctx.body, cur);
      next.questions = ensureQuestionFields(app, ctx.locationId, next.questions);
      savePage(g, next);
      if (!tiersOf(app, g.id).length) {
        db.insert('community_tiers', { id: id(), location_id: ctx.locationId, group_id: g.id, name: 'Mitglied', description: '', position: 0, trial_days: 0, features: [], course_ids: [], tags: [], active: 1, highlight: 0, grace_days: 0, created_at: now(), updated_at: now() });
      }
      if (ctx.body?.set_access_join) switchToJoinMode(g);
      return pageOut(mustGroup(ctx.locationId, g.id));
    });

    const tierRow = (loc: string, tid: string) => {
      const t = parseJson(db.get<any>('SELECT * FROM community_tiers WHERE id = ? AND location_id = ?', tid, loc), ['features', 'course_ids', 'tags']) as Tier | undefined;
      if (!t) throw notFound('Stufe nicht gefunden');
      return t;
    };
    router.post('/api/community/groups/:id/tiers', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const f = cleanTier(app, ctx.locationId, ctx.body);
      const row = { id: id(), location_id: ctx.locationId, group_id: g.id, description: '', trial_days: 0, features: [], course_ids: [], tags: [], active: 1, highlight: 0, grace_days: 0, position: db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM community_tiers WHERE group_id = ?', g.id)!.n, ...f, created_at: now(), updated_at: now() };
      db.insert('community_tiers', row);
      return tierOut(tierRow(ctx.locationId, row.id));
    });
    router.patch('/api/community/tiers/:tid', 'location', (ctx) => {
      const t = tierRow(ctx.locationId, ctx.params.tid);
      db.update('community_tiers', t.id, { ...cleanTier(app, ctx.locationId, ctx.body, t), updated_at: now() });
      return tierOut(tierRow(ctx.locationId, t.id));
    });
    router.delete('/api/community/tiers/:tid', 'location', (ctx) => {
      const t = tierRow(ctx.locationId, ctx.params.tid);
      const live = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE tier_id = ? AND status IN ('active','trialing','past_due','pending','awaiting_payment')`, t.id)!.n;
      if (live) throw bad(`Diese Stufe hat noch ${live} Mitglieder bzw. offene Anfragen – bitte deaktiviere sie stattdessen`);
      db.run('DELETE FROM community_tiers WHERE id = ?', t.id);
      return { ok: true };
    });

    // memberships -----------------------------------------------------------------------------------------------------------
    const memberOut = (m: any, page: PageRow | undefined, tiers: Map<string, Tier>) => {
      const answers = (page?.questions ?? []).filter((q) => m.answers?.[q.id]).map((q) => ({ question: q.label, answer: m.answers[q.id] }));
      return {
        id: m.id,
        contact_id: m.contact_id,
        name: [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || '',
        email: m.email,
        status: m.status,
        tier_id: m.tier_id,
        tier_name: tiers.get(m.tier_id)?.name ?? '',
        billing: m.billing,
        source: m.source,
        joined_at: m.joined_at,
        requested_at: m.requested_at,
        trial_ends_at: m.trial_ends_at,
        converted_at: m.converted_at,
        past_due_at: m.past_due_at,
        cancel_at: m.cancel_at,
        canceled_at: m.canceled_at,
        left_reason: m.left_reason,
        coupon_code: m.coupon_code,
        invite: m.invite_label ?? null,
        note: m.note,
        answers,
      };
    };
    const listMemberships = (locationId: string, groupId: string | null, q: URLSearchParams) => {
      const where = ['m.location_id = ?'];
      const args: any[] = [locationId];
      if (groupId) (where.push('m.group_id = ?'), args.push(groupId));
      const status = (q.get('status') ?? '').split(',').filter(Boolean);
      if (status.length) (where.push(`m.status IN (${status.map(() => '?').join(',')})`), args.push(...status));
      if (q.get('tier_id')) (where.push('m.tier_id = ?'), args.push(q.get('tier_id')));
      const term = String(q.get('q') ?? '').trim();
      if (term) (where.push('(k.first_name LIKE ? OR k.last_name LIKE ? OR k.email LIKE ?)'), args.push(`%${term}%`, `%${term}%`, `%${term}%`));
      const limit = Math.min(Math.max(Number(q.get('limit')) || 200, 1), 1000);
      const rows = parseRows(
        db.all<any>(
          `SELECT m.*, k.first_name, k.last_name, k.email, i.label AS invite_label FROM community_memberships m JOIN contacts k ON k.id = m.contact_id LEFT JOIN community_invites i ON i.id = m.invite_id
           WHERE ${where.join(' AND ')} ORDER BY COALESCE(m.joined_at, m.requested_at) DESC LIMIT ? OFFSET ?`,
          ...args,
          limit,
          Math.max(Number(q.get('offset')) || 0, 0),
        ),
        ['answers'],
      );
      const pages = new Map<string, PageRow | undefined>();
      const tiers = new Map<string, Tier>();
      return rows.map((r) => {
        if (!pages.has(r.group_id)) {
          pages.set(r.group_id, pageOf(app, r.group_id));
          for (const t of tiersOf(app, r.group_id)) tiers.set(t.id, t);
        }
        return { ...memberOut(r, pages.get(r.group_id), tiers), group_id: r.group_id, group_name: db.get<{ name: string }>('SELECT name FROM community_groups WHERE id = ?', r.group_id)?.name ?? '' };
      });
    };
    router.get('/api/community/groups/:id/memberships', 'location', (ctx) => listMemberships(ctx.locationId, mustGroup(ctx.locationId, ctx.params.id).id, ctx.query));
    router.get('/api/community/requests', 'location', (ctx) => {
      ctx.query.set('status', ctx.query.get('status') ?? 'pending');
      return listMemberships(ctx.locationId, null, ctx.query);
    });
    router.post('/api/community/groups/:id/memberships', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const b = ctx.body ?? {};
      let contact = b.contact_id ? getContact(app, ctx.locationId, String(b.contact_id)) : undefined;
      if (!contact) {
        const email = normalizeEmail(b.email);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Kontakt oder E-Mail-Adresse angeben');
        contact = upsertContact(app, ctx.locationId, { email, name: b.name }, { source: `Community: ${g.name}` }).contact;
      }
      const tier = b.tier_id ? tierOf(app, g.id, String(b.tier_id)) : (tiersOf(app, g.id, true)[0] ?? undefined);
      if (b.tier_id && !tier) throw bad('Stufe nicht gefunden');
      const m = openMembership(app, g, contact, { tier_id: tier?.id ?? null, billing: 'free', source: 'admin', status: 'pending', consent: 0 });
      const next = activateMembership(app, g, m, { by: actor(ctx) });
      if (b.send_login_link !== false) void sendWelcome(app, g, contact);
      return { ...memberOut({ ...next, first_name: contact.first_name, last_name: contact.last_name, email: contact.email }, pageOf(app, g.id), new Map(tiersOf(app, g.id).map((t) => [t.id, t]))) };
    });
    router.patch('/api/community/memberships/:mid', 'location', async (ctx) => {
      const m = membershipById(app, ctx.locationId, ctx.params.mid);
      if (!m) throw notFound('Mitgliedschaft nicht gefunden');
      const g = mustGroup(ctx.locationId, m.group_id);
      const b = ctx.body ?? {};
      const action = String(b.action ?? '');
      const contact = getContact(app, ctx.locationId, m.contact_id);
      if (action === 'approve') await approveMembership(app, g, m, actor(ctx));
      else if (action === 'reject') {
        if (m.status !== 'pending') throw bad('Diese Anfrage ist nicht mehr offen');
        rejectMembership(app, g, m, actor(ctx), String(b.note ?? ''));
        if (b.notify !== false && contact?.email) await communityMail(app, ctx.locationId, contact.email, `Dein Beitritt zu „${g.name}“`, [`Leider können wir deine Anfrage für „${g.name}“ im Moment nicht annehmen.`, ...(b.note ? [String(b.note).slice(0, 300)] : [])]);
      } else if (action === 'end') {
        if (!LIVE_STATUSES.includes(m.status)) throw bad('Diese Mitgliedschaft läuft nicht');
        endMembership(app, g, m, 'removed', { by: actor(ctx) });
      } else if (action === 'reactivate') {
        if (grants(app, m)) throw bad('Diese Mitgliedschaft läuft schon');
        activateMembership(app, g, openMembership(app, g, contact!, { tier_id: m.tier_id, billing: 'free', source: 'admin', status: 'pending' }), { by: actor(ctx) });
      } else if (action === 'tier') {
        const tier = tierOf(app, g.id, String(b.tier_id ?? ''));
        if (!tier) throw bad('Stufe nicht gefunden');
        db.run('UPDATE community_memberships SET tier_id = ?, updated_at = ? WHERE id = ?', tier.id, now(), m.id);
        if (grants(app, m)) activateMembership(app, g, { ...m, tier_id: tier.id }, { by: actor(ctx) });
      } else if (b.note !== undefined) db.run('UPDATE community_memberships SET note = ? WHERE id = ?', String(b.note).slice(0, 300), m.id);
      else throw bad('Aktion: approve, reject, end, reactivate oder tier');
      const out = listMemberships(ctx.locationId, g.id, new URLSearchParams({ q: contact?.email ?? '' })).find((x) => x.id === m.id);
      return out ?? { ok: true };
    });

    // invites ---------------------------------------------------------------------------------------------------------------------
    const inviteOut = (i: Invite, page: PageRow | undefined) => ({
      ...i,
      url: page ? `${joinUrlOf(page)}/i/${encodeURIComponent(i.code)}` : null,
      members: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE invite_id = ? AND status IN ('active','trialing','past_due')`, i.id)!.n,
      pending: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM community_memberships WHERE invite_id = ? AND status IN ('pending','awaiting_payment')`, i.id)!.n,
    });
    router.get('/api/community/groups/:id/invites', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const page = pageOf(app, g.id);
      return db.all<Invite>('SELECT * FROM community_invites WHERE group_id = ? ORDER BY created_at DESC', g.id).map((i) => inviteOut(i, page));
    });
    router.post('/api/community/groups/:id/invites', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const f = cleanInvite(app, g, ctx.body);
      let code = f.code ?? newInviteCode();
      while (!f.code && db.get('SELECT 1 FROM community_invites WHERE group_id = ? AND code = ?', g.id, code)) code = newInviteCode();
      const row = { id: id(), location_id: ctx.locationId, group_id: g.id, label: '', skip_approval: 0, uses: 0, active: 1, ...f, code, created_by: actor(ctx), created_at: now() };
      db.insert('community_invites', row);
      return inviteOut(db.get<Invite>('SELECT * FROM community_invites WHERE id = ?', row.id)!, pageOf(app, g.id));
    });
    const inviteRow = (loc: string, iid: string) => {
      const i = db.get<Invite>('SELECT * FROM community_invites WHERE id = ? AND location_id = ?', iid, loc);
      if (!i) throw notFound('Einladung nicht gefunden');
      return i;
    };
    router.patch('/api/community/invites/:iid', 'location', (ctx) => {
      const i = inviteRow(ctx.locationId, ctx.params.iid);
      const g = mustGroup(ctx.locationId, i.group_id);
      db.update('community_invites', i.id, cleanInvite(app, g, ctx.body, i));
      return inviteOut(inviteRow(ctx.locationId, i.id), pageOf(app, g.id));
    });
    router.delete('/api/community/invites/:iid', 'location', (ctx) => {
      db.run('DELETE FROM community_invites WHERE id = ?', inviteRow(ctx.locationId, ctx.params.iid).id);
      return { ok: true };
    });

    // discount codes --------------------------------------------------------------------------------------------------------------
    const couponOut = (c: Coupon) => ({ ...c, text: couponLabel(c) });
    router.get('/api/community/groups/:id/coupons', 'location', (ctx) => db.all<Coupon>('SELECT * FROM community_coupons WHERE group_id = ? ORDER BY created_at DESC', mustGroup(ctx.locationId, ctx.params.id).id).map(couponOut));
    router.post('/api/community/groups/:id/coupons', 'location', (ctx) => {
      const g = mustGroup(ctx.locationId, ctx.params.id);
      const row = { id: id(), location_id: ctx.locationId, group_id: g.id, label: '', uses: 0, active: 1, created_at: now(), ...cleanCoupon(app, g, ctx.body) };
      db.insert('community_coupons', row);
      return couponOut(db.get<Coupon>('SELECT * FROM community_coupons WHERE id = ?', row.id)!);
    });
    const couponRow = (loc: string, cid: string) => {
      const c = db.get<Coupon>('SELECT * FROM community_coupons WHERE id = ? AND location_id = ?', cid, loc);
      if (!c) throw notFound('Rabattcode nicht gefunden');
      return c;
    };
    router.patch('/api/community/coupons/:cid', 'location', (ctx) => {
      const c = couponRow(ctx.locationId, ctx.params.cid);
      db.update('community_coupons', c.id, cleanCoupon(app, mustGroup(ctx.locationId, c.group_id), ctx.body, c));
      return couponOut(couponRow(ctx.locationId, c.id));
    });
    router.delete('/api/community/coupons/:cid', 'location', (ctx) => {
      db.run('DELETE FROM community_coupons WHERE id = ?', couponRow(ctx.locationId, ctx.params.cid).id);
      return { ok: true };
    });

    // --- public pages ----------------------------------------------------------------------------------------------------------------
    router.get('/community-join.js', 'public', () => {
      const r = text(JOIN_JS, 'text/javascript; charset=utf-8');
      r.headers['cache-control'] = 'public, max-age=3600';
      return r;
    });

    const loginUrl = (g: G) => portalUrl(app, g.location_id);
    router.get('/c/:slug', 'public', (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f) return missing();
      const { page, g, loc } = f;
      const attr = app.services.attribution?.visit(ctx, g.location_id) ?? '';
      const tiers = tiersOf(app, g.id, true).map(tierView);
      const invite = usableInvite(app, g.id, ctx.query.get('i'));
      const qs = new URLSearchParams({ ...(attr ? { a: attr } : {}), ...(invite ? { i: invite.code } : {}) });
      const base = `/c/${encodeURIComponent(page.slug)}`;
      return aboutHtml(app, loc, {
        g,
        page,
        tiers,
        members: memberCount(app, g.id),
        admins: adminsOf(g),
        joinUrl: `${base}/join${qs.size ? `?${qs}` : ''}`,
        loginUrl: loginUrl(g),
        discoverUrl: '/communities',
        canonical: abs(base),
      });
    });
    router.get('/c/:slug/i/:code', 'public', (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f) return missing();
      return redirect(`/c/${encodeURIComponent(f.page.slug)}/join?i=${encodeURIComponent(ctx.params.code)}`);
    });

    const formToken = (slug: string, at = Date.now()) => `${at}.${createHmac('sha256', app.config.secret).update(`community-form:${slug}:${at}`).digest('hex').slice(0, 24)}`;
    const formTokenOk = (slug: string, tok: unknown) => {
      const [t] = String(tok ?? '').split('.');
      const at = Number(t);
      return Number.isFinite(at) && Date.now() - at < 6 * 3600_000 && at <= Date.now() + 60_000 && safeEqual(formToken(slug, at), tok);
    };
    const formData = (ctx: Ctx, f: NonNullable<ReturnType<typeof findPublic>>, extra: Partial<Parameters<typeof joinHtml>[2]> = {}) => {
      const { page, g } = f;
      const invite = usableInvite(app, g.id, ctx.query.get('i') ?? ctx.body?.invite);
      const tiers = tiersOf(app, g.id, true).map(tierView);
      const attr = attrParam(ctx) || (app.services.attribution?.visit(ctx, g.location_id) ?? '');
      return {
        g,
        page,
        tiers,
        formToken: formToken(page.slug),
        action: `/c/${encodeURIComponent(page.slug)}/join`,
        selectedTier: ctx.query.get('tier') ?? undefined,
        invite: invite ? { code: invite.code, skip_approval: !!invite.skip_approval } : undefined,
        couponVisible: !!db.get(`SELECT 1 FROM community_coupons WHERE group_id = ? AND active = 1 LIMIT 1`, g.id),
        couponUrl: `/api/public/communities/${encodeURIComponent(page.slug)}/coupon`,
        attr,
        ...extra,
      } satisfies Parameters<typeof joinHtml>[2];
    };
    const attrParam = (ctx: Ctx): string => {
      const a = String(ctx.query.get('a') ?? '');
      return a && a.length < 200 ? a : '';
    };

    router.get('/c/:slug/join', 'public', (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f) return missing();
      return joinHtml(app, f.loc, formData(ctx, f));
    });

    const mailedNotice = (f: NonNullable<ReturnType<typeof findPublic>>, text?: string) =>
      noticeHtml(app, f.loc, { title: 'Fast geschafft – schau in dein Postfach', text: text ?? `Wir haben dir einen Login-Link für „${f.g.name}“ geschickt. Er gilt 30 Minuten.`, button: ['Zum Mitgliederbereich', loginUrl(f.g)] });

    router.post('/c/:slug/join', 'public', async (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f) return missing();
      const { page, g } = f;
      const b = ctx.body ?? {};
      const fail = (status: number, error: string, values = b) => {
        const r = joinHtml(app, f.loc, formData(ctx, f, { error, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v ?? '').slice(0, 500)])) }));
        r.status = status;
        return r;
      };
      if (!sameOrigin(ctx)) return fail(403, 'Bitte lade die Seite neu und versuche es noch einmal.');
      if (limited(`join:${ctx.ip}`, app.services.communityLimits?.join ?? LIMIT_DEFAULTS.join, 3600_000)) return fail(429, 'Zu viele Versuche – bitte in einer Stunde noch einmal.');
      if (!formTokenOk(page.slug, b._t)) return fail(400, 'Das Formular war zu lange offen. Bitte noch einmal absenden.');
      // A bot filled the hidden field: it gets the friendly answer and nothing happens.
      if (String(b.website ?? '').trim()) return mailedNotice(f);
      if ((page.terms_url || page.privacy_url) && !b.terms) return fail(400, 'Bitte bestätige AGB und Datenschutzhinweise.');
      const answers: Record<string, string> = {};
      for (const q of page.questions) answers[q.id] = String(b[`q_${q.id}`] ?? '');
      try {
        const r = joinCommunity(app, g, page, { name: b.name, email: b.email, tier_id: b.tier, billing: b.billing, answers, consent: !!b.consent, invite: b.invite, coupon: b.coupon });
        app.services.attribution?.capture(ctx, g.location_id, r.contact.id, 'community', { attr: b._a, page: `/c/${page.slug}`, referrer: String(ctx.req.headers.referer ?? ''), params: b });
        // The consent box of the page goes into the consent ledger (modules/consent-capture.ts).
        app.services.consent?.captureCommunity?.(ctx, g, page, r.contact, b);
        if (r.next === 'checkout' && r.url) return redirect(r.url, 303);
        if (r.next === 'pending') return noticeHtml(app, f.loc, { title: 'Anfrage eingegangen', text: page.success_text || `Danke, ${String(b.name).split(' ')[0]}! Das Team schaut sich deine Anfrage an. Du bekommst eine E-Mail, sobald es weitergeht.`, button: ['Zurück zur Seite', `/c/${encodeURIComponent(page.slug)}`] });
        // Free join (or somebody who is in already): the login link goes to the address – never an instant session.
        if (!limited(`join-mail:${normalizeEmail(b.email)}`, 3, 15 * 60_000)) await sendWelcome(app, g, r.contact);
        return mailedNotice(f, page.success_text || undefined);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        throw e;
      }
    });

    router.get('/c/:slug/willkommen', 'public', async (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f) return missing();
      let m = membershipFrom(f.g.location_id, ctx.query.get('cm'));
      if (!m || m.group_id !== f.g.id) return noticeHtml(app, f.loc, { title: 'Link ungültig', text: 'Dieser Link ist abgelaufen oder gehört nicht zu dieser Community.', button: ['Zur Community-Seite', `/c/${encodeURIComponent(f.page.slug)}`], status: 400 });
      // The payment event may be a moment behind: settle from the paid checkout right here (idempotent).
      if (!grants(app, m)) {
        const paid = db.get<any>(`SELECT * FROM stripe_checkouts WHERE location_id = ? AND kind = 'product' AND status = 'paid' AND json_extract(meta, '$.community_membership') = ? ORDER BY created_at DESC LIMIT 1`, f.g.location_id, m.id);
        if (paid) settlePurchase(f.g.location_id, { contactId: paid.contact_id, productId: paid.product_id, metadata: parseJson({ meta: paid.meta }, ['meta']).meta, sessionId: paid.id });
        m = membershipById(app, f.g.location_id, m.id)!;
      }
      if (!grants(app, m)) return noticeHtml(app, f.loc, { title: 'Wir bestätigen deine Zahlung', text: 'Das dauert normalerweise nur einen Moment. Du bekommst eine E-Mail mit deinem Login-Link, sobald alles durch ist.', button: ['Seite neu laden', ctx.url.pathname + ctx.url.search] });
      const contact = getContact(app, f.g.location_id, m.contact_id);
      if (contact && !limited(`welcome-mail:${m.id}`, 2, 15 * 60_000)) await sendWelcome(app, f.g, contact);
      return noticeHtml(app, f.loc, {
        title: m.status === 'trialing' ? 'Deine Testphase läuft' : 'Willkommen – du bist dabei!',
        text: `${f.page.success_text || `Schön, dass du da bist.`} Wir haben dir einen Login-Link per E-Mail geschickt – damit kommst du in den Mitgliederbereich.`,
        button: ['Zum Mitgliederbereich', loginUrl(f.g)],
      });
    });

    router.get('/c/:slug/avatar/:fid', 'public', (ctx) => {
      const f = findPublic(ctx.params.slug);
      if (!f || !f.page.show_admins) return missing();
      const ok = db.get(
        `SELECT 1 FROM community_roles r JOIN community_profiles p ON p.location_id = r.location_id AND p.contact_id = r.contact_id WHERE r.group_id = ? AND r.role = 'admin' AND p.avatar_file_id = ?`,
        f.g.id,
        ctx.params.fid,
      );
      const file = ok && db.get<{ file: string; mime: string }>('SELECT * FROM community_files WHERE id = ? AND location_id = ?', ctx.params.fid, f.g.location_id);
      const r = file && fileResponse(app, file);
      if (!r) return missing();
      return r;
    });

    router.get('/api/public/communities/:slug/coupon', 'public', (ctx) => {
      if (limited(`coupon:${ctx.ip}`, app.services.communityLimits?.coupon ?? LIMIT_DEFAULTS.coupon, 10 * 60_000)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
      const f = findPublic(ctx.params.slug);
      if (!f) throw notFound();
      const r = usableCoupon(app, f.g.id, ctx.query.get('code'), ctx.query.get('tier'));
      if ('error' in r) return { ok: false, error: r.error };
      return { ok: true, label: `${r.coupon.label || r.coupon.code}: ${couponLabel(r.coupon)}` };
    });

    // --- Discovery -----------------------------------------------------------------------------------------------------------------
    router.get('/communities', 'public', (ctx) => {
      if (process.env.PGHL_COMMUNITY_DISCOVERY === '0') return missing();
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 60).toLowerCase();
      const category = String(ctx.query.get('category') ?? '').trim().slice(0, 40);
      const rows = db.all<any>(
        `SELECT p.*, g.name AS g_name, g.cover_image AS g_cover, g.description AS g_desc, g.location_id AS loc FROM community_pages p JOIN community_groups g ON g.id = p.group_id
         WHERE p.enabled = 1 AND p.discoverable = 1 AND g.status = 'active'`,
      );
      const categories = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort() as string[];
      const items: DiscoverItem[] = rows
        .filter((r) => (!category || r.category === category) && (!q || `${r.g_name} ${r.tagline} ${r.category}`.toLowerCase().includes(q)))
        .map((r) => {
          const views = tiersOf(app, r.group_id, true).map(tierView);
          const prices = views.flatMap((v) => (v.prices.free ? [{ c: 0, t: 'Kostenlos' }] : (['month', 'year', 'once'] as const).filter((x) => v.prices[x]).map((x) => ({ c: v.prices[x]!.gross_cents / (x === 'year' ? 12 : 1), t: priceText(v.prices[x]!) }))));
          const min = prices.sort((a, b) => a.c - b.c)[0];
          const loc = app.location(r.loc);
          return { slug: r.slug, name: r.g_name, tagline: r.tagline || '', cover: r.cover_image || r.g_cover || '', color: loc ? publicBrand(loc).color : '#2563eb', members: r.show_member_count ? memberCount(app, r.group_id) : 0, from: min ? (views.length > 1 && min.c > 0 ? `ab ${min.t}` : min.t) : 'Kostenlos', category: r.category || '', brand: loc ? publicBrand(loc).name : '' };
        })
        .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
      return discoverHtml(app, { items, q, category, categories, title: 'Communities' });
    });
  },
};
