import type { App, Module } from '../core/app.js';
import { HttpError, type Auth, type Ctx } from '../core/http.js';
import { sealSecret } from '../core/secrets.js';
import { id, now } from '../core/util.js';
import {
  ALL_AREAS,
  CLIENT_PLAN_ID,
  METRICS,
  PLAN_INFO,
  PLAN_KEYS,
  defaultSettings,
  entitlements,
  planIdOf,
  planKeyOf,
  priceFor,
  yearlyCents,
  type CloudSettings,
  type FairUse,
  type PlanKey,
} from '../services/cloud.js';
import { ACCEPTED_DOCS, DEFAULT_LEGAL, LEGAL_DOCS, fillLegal, legalHash, type LegalDoc } from '../services/cloud-legal.js';
import { waitlistReason, type WlReason } from '../services/cloud-waitlist.js';
import { composeMail, type MailKind, type MailVars } from '../services/cloud-mail.js';
import { deliverEmail } from '../services/messaging.js';
import { eraseLocations, eraseUserRows } from '../services/cloud-export.js';
import { isReadOnly, readOnlyMessage, type Subscription } from '../services/saas.js';
import { isSecretKey, isWebhookSecret, keyHint, isLiveKey } from '../services/stripe.js';
import { getBranding } from './agency.js';
import { planById, saasSettings, saasStripe, stockCount, stripeKeyOf, subscriptionOf, upsertSubscription, usageOf } from './saas.js';

/**
 * Cloud mode (PGHL_CLOUD_MODE=1): the hosted service – self-serve signup, billing, tenants, operator console.
 * This module is the shared base: tables, the operator's settings, the plan rows (they live in the SaaS tables, so the
 * SaaS gate, usage metering and Stripe lifecycle do the work), tenant lookups, mails, the guards and the customer's
 * own summary. Public pages: cloud-pages.ts, signup/provisioning: cloud-signup.ts, billing: cloud-billing.ts,
 * the customer's account area: cloud-account.ts, the operator console: cloud-console.ts. Without the flag no route,
 * guard or hook is registered – self-hosters see no change. Design and operator setup: docs/cloud.md.
 */

export const cloudEnabled = (app: App) => app.config.cloudMode ?? process.env.PGHL_CLOUD_MODE === '1';

/**
 * Waitlist mode (docs/cloud.md#waitlist-mode): nobody can sign up for or pay for the cloud, the public pages offer a waitlist
 * instead. `PGHL_CLOUD_WAITLIST=1` / `=0` decide; unset, it is on while the cloud mode has no billing (no Stripe key). Read on
 * every request, so entering a Stripe key in the console opens the signup without a restart. Gate and list: modules/cloud-waitlist.ts.
 */
export const cloudWaitlistReason = (app: App): WlReason | null => waitlistReason({ env: process.env.PGHL_CLOUD_WAITLIST, cloud: cloudEnabled(app), billing: cloudBillingReady(app) });
/** The operator's Stripe key is set and readable (a key that cannot be opened bills nobody). */
function cloudBillingReady(app: App): boolean {
  try {
    return !!stripeKeyOf(app);
  } catch {
    return false;
  }
}
export const cloudWaitlist = (app: App) => cloudWaitlistReason(app) !== null;

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  email: string;
  location_id: string;
  owner_user_id: string | null;
  coupon: string;
  comped: number;
  comp_until: string | null;
  support_until: string | null;
  read_only_since: string | null;
  schedule_notified_at: string | null;
  deletion_at: string | null;
  deletion_reason: string;
  cancel_reason: string;
  cancel_comment: string;
  trial_started_at: string | null;
  converted_at: string | null;
  notes: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type Phase = 'trial' | 'active' | 'comped' | 'past_due' | 'read_only' | 'canceled' | 'deletion_scheduled';

// --- settings -------------------------------------------------------------------------------------------------

export function cloudSettings(app: App): CloudSettings {
  const base = defaultSettings();
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', 'cloud');
  if (!row) return base;
  try {
    const v = JSON.parse(row.value);
    const fair = Object.fromEntries(PLAN_KEYS.map((k) => [k, { ...base.fair_use[k], ...(v.fair_use?.[k] ?? {}) }])) as Record<PlanKey, FairUse>;
    return { ...base, ...v, prices: { ...base.prices, ...v.prices }, fair_use: fair, overage: { ...base.overage, ...v.overage }, unit_cost: { ...base.unit_cost, ...v.unit_cost }, operator: { ...base.operator, ...v.operator } };
  } catch {
    return base;
  }
}

export function saveCloudSettings(app: App, s: CloudSettings) {
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'cloud', JSON.stringify(s));
  syncSaasSettings(app, s);
  ensureCloudPlans(app);
}

/** The values the SaaS lifecycle reads (grace period, rebilling costs) follow the cloud settings. */
function syncSaasSettings(app: App, s: CloudSettings) {
  const cur = saasSettings(app);
  const next = { ...cur, grace_days: s.grace_days, unit_cost: { ...s.unit_cost }, markup_percent: s.markup_percent };
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'saas', JSON.stringify(next));
}

/** Stripe keys from the environment (PGHL_CLOUD_STRIPE_SECRET_KEY / _WEBHOOK_SECRET) are stored sealed when none is set yet. */
function seedStripeFromEnv(app: App) {
  const key = process.env.PGHL_CLOUD_STRIPE_SECRET_KEY?.trim() ?? '';
  const hook = process.env.PGHL_CLOUD_STRIPE_WEBHOOK_SECRET?.trim() ?? '';
  if (!key && !hook) return;
  const cur = saasSettings(app);
  const next = { ...cur };
  if (key && !cur.secret_key && isSecretKey(key)) Object.assign(next, { secret_key: sealSecret(app, key), key_hint: keyHint(key), livemode: isLiveKey(key), checked_at: now() });
  if (hook && !cur.webhook_secret && isWebhookSecret(hook)) next.webhook_secret = sealSecret(app, hook);
  if (next.secret_key !== cur.secret_key || next.webhook_secret !== cur.webhook_secret) app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'saas', JSON.stringify(next));
}

/** The plan rows in saas_plans: cloud-solo / -team / -agency and the price-less client plan. Prices, trial and limits follow the settings. */
export function ensureCloudPlans(app: App) {
  const s = cloudSettings(app);
  const t = now();
  const upsert = (planId: string, name: string, description: string, month: number, year: number, users: number | null, fair: FairUse, sort: number) =>
    app.db.run(
      `INSERT INTO saas_plans (id, name, description, currency, price_month_cents, price_year_cents, trial_days, features, limits, overage, markup_percent, snapshot_id, public, active, sort, created_at, updated_at)
       VALUES (?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, price_month_cents = excluded.price_month_cents, price_year_cents = excluded.price_year_cents,
         trial_days = excluded.trial_days, features = excluded.features, limits = excluded.limits, overage = excluded.overage, sort = excluded.sort, updated_at = excluded.updated_at`,
      planId,
      name,
      description,
      month,
      year,
      s.trial_days,
      JSON.stringify(ALL_AREAS),
      JSON.stringify({ users, emails: fair.emails, sms: fair.sms, ai: fair.ai }),
      JSON.stringify(s.overage),
      sort,
      t,
      t,
    );
  const before = new Map(app.db.all<{ id: string; price_month_cents: number; price_year_cents: number }>(`SELECT id, price_month_cents, price_year_cents FROM saas_plans WHERE id LIKE 'cloud-%'`).map((r) => [r.id, r]));
  PLAN_KEYS.forEach((k, i) => upsert(planIdOf(k), PLAN_INFO[k].name, PLAN_INFO[k].tagline, s.prices[k], yearlyCents(s.prices[k], s.yearly_discount_percent), PLAN_INFO[k].users, s.fair_use[k], 900 + i));
  upsert(CLIENT_PLAN_ID, 'Cloud Agentur – Kunden-Account', 'Inklusive in deinem Agentur-Tarif.', 0, 0, null, s.fair_use.agency, 990);
  // A changed price needs a new Stripe price (the old one is archived by the SaaS sync).
  for (const k of PLAN_KEYS) {
    const old = before.get(planIdOf(k));
    if (old && (old.price_month_cents !== s.prices[k] || old.price_year_cents !== yearlyCents(s.prices[k], s.yearly_discount_percent))) void app.services.saasSyncPlan?.(planIdOf(k))?.catch?.(() => undefined);
  }
}

// --- tenants ----------------------------------------------------------------------------------------------------

export const tenantById = (app: App, tid: string): Tenant | undefined => app.db.get<Tenant>('SELECT * FROM cloud_tenants WHERE id = ? AND deleted_at IS NULL', tid);
export const tenantOfLocation = (app: App, locationId: string): Tenant | undefined =>
  app.db.get<Tenant>('SELECT t.* FROM cloud_locations l JOIN cloud_tenants t ON t.id = l.tenant_id WHERE l.location_id = ? AND t.deleted_at IS NULL', locationId);
export const tenantOfUser = (app: App, userId: string): { tenant: Tenant; role: 'owner' | 'member'; all_locations: boolean } | undefined => {
  const m = app.db.get<{ tenant_id: string; role: string; all_locations: number }>('SELECT tenant_id, role, all_locations FROM cloud_members WHERE user_id = ?', userId);
  const tenant = m && tenantById(app, m.tenant_id);
  return m && tenant ? { tenant, role: m.role === 'owner' ? 'owner' : 'member', all_locations: !!m.all_locations } : undefined;
};
/** The tenant of the signed-in customer (owner only for changes). */
export function requireTenant(app: App, ctx: Ctx, mustOwn = true): Tenant {
  const m = ctx.user ? tenantOfUser(app, ctx.user.id) : undefined;
  if (!m) throw new HttpError(403, 'Dieses Konto gehört zu keinem Cloud-Tarif');
  // A login for one client account of an Agentur sees nothing of the tenant around it.
  if (m.role !== 'owner' && !m.all_locations) throw new HttpError(403, 'Dieser Login gehört zu einem einzelnen Kunden-Account – die Verwaltung liegt bei deiner Agentur.');
  if (mustOwn && m.role !== 'owner') throw new HttpError(403, 'Das darf nur die Inhaberin bzw. der Inhaber des Kontos');
  return m.tenant;
}

/** A first set of e-mail templates for a new sub-account (when no default snapshot is set). */
export function starterContent(app: App, locationId: string) {
  const t = now();
  for (const [name, subject, body] of [
    ['Willkommen', 'Willkommen bei {{company}}', 'Hallo {{first_name}},\n\nschön, dass du da bist. Melde dich einfach, wenn du Fragen hast.\n\nViele Grüße'],
    ['Terminbestätigung', 'Dein Termin bei {{company}}', 'Hallo {{first_name}},\n\ndein Termin ist bestätigt. Bis bald!\n\nViele Grüße'],
    ['Nachfassen', 'Kurze Rückfrage', 'Hallo {{first_name}},\n\nich wollte kurz nachfragen, ob du noch Fragen zu unserem Angebot hast.\n\nViele Grüße'],
  ]) app.db.insert('templates', { id: id(), location_id: locationId, name, channel: 'email', subject, body, is_html: 0, created_at: t, updated_at: t });
}

/**
 * Salaries and bank data in the Personal area may only be seen by agency admins and by people the area lists. A customer has no agency
 * admin, so the owner is listed from the start (they can add others in the Personal settings).
 */
export function grantOwnerHr(app: App, locationId: string, userId: string) {
  if (!app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'hr_settings'`)) return;
  const row = app.db.get<{ data: string }>('SELECT data FROM hr_settings WHERE location_id = ?', locationId);
  let cur: Record<string, any> = {};
  try {
    cur = row ? JSON.parse(row.data) : {};
  } catch {
    cur = {};
  }
  const ids = new Set<string>(Array.isArray(cur.sensitive_user_ids) ? cur.sensitive_user_ids : []);
  ids.add(userId);
  app.db.run(`INSERT INTO hr_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, locationId, JSON.stringify({ ...cur, sensitive_user_ids: [...ids] }), now());
}

export const tenantLocationIds = (app: App, tid: string): string[] => app.db.all<{ location_id: string }>('SELECT location_id FROM cloud_locations WHERE tenant_id = ? ORDER BY role DESC, created_at', tid).map((r) => r.location_id);
export const tenantSub = (app: App, t: Tenant): Subscription | undefined => subscriptionOf(app, t.location_id);
export const tenantPlanKey = (app: App, t: Tenant): PlanKey => planKeyOf(tenantSub(app, t)?.plan_id) ?? 'team';

export function logCloudEvent(app: App, tenantId: string | null, type: string, detail = '') {
  app.db.insert('cloud_events', { id: id(), tenant_id: tenantId, type, detail: detail.slice(0, 500), at: now() });
  tapCloudEvent(app, tenantId, type, detail);
}

/**
 * Lifecycle taps: `app.services.cloudEventTaps` – functions `(app, tenantId, type, detail)` called after every tenant event
 * (and for the trial-ending reminder, which is a mail, not an event). Synchronous, may run inside a transaction (the hard
 * delete); a failing tap never breaks billing. Used by modules/cloud-hq-bridge.ts.
 */
export function tapCloudEvent(app: App, tenantId: string | null, type: string, detail = '') {
  if (!tenantId) return;
  for (const fn of (app.services.cloudEventTaps ?? []) as ((app: App, tenantId: string, type: string, detail: string) => void)[]) {
    try {
      fn(app, tenantId, type, detail);
    } catch (e) {
      console.error('[cloud] event tap', (e as Error).message);
    }
  }
}

export const supportActive = (t: Pick<Tenant, 'support_until'>, at = new Date()) => !!t.support_until && t.support_until > at.toISOString();

export function phaseOf(t: Tenant, sub: Subscription | undefined): Phase {
  if (t.deletion_at) return 'deletion_scheduled';
  switch (sub?.status) {
    case 'trialing':
      return 'trial';
    case 'past_due':
      return 'past_due';
    case 'paused':
      return 'read_only';
    case 'canceled':
      return 'canceled';
    default:
      return t.comped ? 'comped' : 'active';
  }
}

export const PHASE_LABEL: Record<Phase, string> = { trial: 'Testphase', active: 'aktiv', comped: 'geschenkt', past_due: 'Zahlung offen', read_only: 'schreibgeschützt', canceled: 'gekündigt', deletion_scheduled: 'Löschung geplant' };

// --- links and mails ------------------------------------------------------------------------------------------------

export const cloudBrand = (app: App) => getBranding(app).name || 'HyperLevel';
export const cloudSupport = (app: App) => cloudSettings(app).support_email || getBranding(app).support_email || cloudSettings(app).operator.email || '';
export const appLink = (app: App, path = '') => `${app.baseUrl()}${path}`;
export const billingLink = (app: App) => appLink(app, '/app/settings/cloud');
export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }) : '');

/** The sub-account the system mails go out of: the operator's choice, the SaaS one, else the oldest non-tenant sub-account. */
function mailSender(app: App) {
  const s = cloudSettings(app);
  for (const lid of [s.mail_location_id, saasSettings(app).mail_location_id]) {
    const l = lid ? app.location(lid) : undefined;
    if (l) return l;
  }
  const row = app.db.get<{ id: string }>('SELECT id FROM locations WHERE id NOT IN (SELECT location_id FROM cloud_locations) ORDER BY created_at LIMIT 1');
  return row ? app.location(row.id) : undefined;
}

/** Sends one system mail; with `dedupe` (tenant + key) each reminder goes out once. Returns what happened. */
export async function sendCloudMail(app: App, kind: MailKind, to: string, vars: Partial<MailVars> = {}, o: { tenantId?: string; dedupe?: string } = {}): Promise<string> {
  if (!to) return 'no_recipient';
  if (o.tenantId && o.dedupe && !app.db.run('INSERT OR IGNORE INTO cloud_mails (tenant_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)', o.tenantId, kind, o.dedupe, now()).changes) return 'duplicate';
  if (kind === 'trial_ending') tapCloudEvent(app, o.tenantId ?? null, 'trial_ending', String(vars.trial_end ?? ''));
  const undo = () => o.tenantId && o.dedupe && app.db.run('DELETE FROM cloud_mails WHERE tenant_id = ? AND kind = ? AND ref = ?', o.tenantId, kind, o.dedupe);
  const sender = mailSender(app);
  if (!sender) {
    undo();
    logCloudEvent(app, o.tenantId ?? null, 'mail_failed', `${kind}: kein Absender-Sub-Account`);
    return 'no_sender';
  }
  const m = composeMail(kind, { brand: cloudBrand(app), support: cloudSupport(app), ...vars });
  try {
    await (app.services.cloudMailer ?? deliverEmail)(sender, { to, subject: m.subject, text: m.text, html: m.html });
    return 'sent';
  } catch (e) {
    undo();
    logCloudEvent(app, o.tenantId ?? null, 'mail_failed', `${kind}: ${(e as Error).message}`);
    return 'failed';
  }
}

// --- legal documents -------------------------------------------------------------------------------------------------

export interface LegalRow {
  doc: LegalDoc;
  version: number;
  body: string;
  hash: string;
  created_at: string;
}

function ensureLegal(app: App) {
  for (const doc of LEGAL_DOCS) {
    if (!app.db.get('SELECT 1 AS x FROM cloud_legal WHERE doc = ? LIMIT 1', doc)) app.db.insert('cloud_legal', { doc, version: 1, body: DEFAULT_LEGAL[doc], hash: legalHash(DEFAULT_LEGAL[doc]), created_at: now(), created_by: '' });
  }
}
export const legalCurrent = (app: App, doc: LegalDoc): LegalRow => app.db.get<LegalRow>('SELECT * FROM cloud_legal WHERE doc = ? ORDER BY version DESC LIMIT 1', doc)!;
export const legalVersion = (app: App, doc: LegalDoc, version: number): LegalRow | undefined => app.db.get<LegalRow>('SELECT * FROM cloud_legal WHERE doc = ? AND version = ?', doc, version);

/** Saves a new version when the text changed; returns the current row. */
export function setLegal(app: App, doc: LegalDoc, body: string, by: string): LegalRow {
  const cur = legalCurrent(app, doc);
  const hash = legalHash(body);
  if (hash === cur.hash) return cur;
  app.db.insert('cloud_legal', { doc, version: cur.version + 1, body, hash, created_at: now(), created_by: by.slice(0, 200) });
  return legalCurrent(app, doc);
}

/** A document with its placeholders filled in (the customer's company when known). */
export function legalText(app: App, row: LegalRow, o: { company?: string; email?: string } = {}): string {
  const s = cloudSettings(app);
  return fillLegal(row.body, {
    operator: s.operator,
    service: cloudBrand(app),
    company: o.company ?? '[Name deiner Firma]',
    email: o.email,
    trial_days: s.trial_days,
    grace_days: s.grace_days,
    retention_days: s.retention_days,
    deletion_notice_days: s.deletion_notice_days,
    version: row.version,
    date: fmtDay(row.created_at),
  });
}

/** Writes the acceptance of the documents (name of the document, version, text hash, time) for a signup / tenant. */
export function recordAcceptance(app: App, o: { signupId?: string; tenantId?: string; userId?: string; ip: string; versions: Partial<Record<LegalDoc, number>> }) {
  const at = now();
  // IP kept coarse: last octet / last 80 bits dropped.
  const ip = o.ip.includes(':') ? o.ip.split(':').slice(0, 3).join(':') + '::' : o.ip.replace(/\.\d+$/, '.0');
  for (const doc of ACCEPTED_DOCS) {
    const version = o.versions[doc];
    const row = version ? legalVersion(app, doc, version) : undefined;
    if (!row) continue;
    app.db.insert('cloud_acceptances', { id: id(), signup_id: o.signupId ?? null, tenant_id: o.tenantId ?? null, user_id: o.userId ?? null, doc, version: row.version, hash: row.hash, at, ip });
  }
}

/** Documents with a newer version than the tenant accepted last. */
export function pendingLegal(app: App, tenantId: string): { doc: LegalDoc; version: number }[] {
  const out: { doc: LegalDoc; version: number }[] = [];
  for (const doc of ACCEPTED_DOCS) {
    const cur = legalCurrent(app, doc);
    const last = Number(app.db.get<{ v: number }>('SELECT MAX(version) AS v FROM cloud_acceptances WHERE tenant_id = ? AND doc = ?', tenantId, doc)?.v ?? 0);
    if (last < cur.version) out.push({ doc, version: cur.version });
  }
  return out;
}

// --- the tenant's numbers ---------------------------------------------------------------------------------------------

const MB = 1024 * 1024;
/** What a sub-account keeps on disk: media uploads, course and community videos, call audio, recordings of meetings, the files visitors send through public forms and project files (tables a module does not load count as nothing). */
const STORAGE_TABLES: [table: string, column: string][] = [['uploads', 'size'], ['course_videos', 'size'], ['community_videos', 'size'], ['call_audio', 'bytes'], ['call_intel', 'audio_bytes'], ['form_files', 'size'], ['project_files', 'size']];
export const storageUsedBytes = (app: App, locationId: string) => {
  let sum = 0;
  for (const [table, column] of STORAGE_TABLES) {
    try {
      sum += Number(app.db.get<{ n: number }>(`SELECT COALESCE(SUM(${column}), 0) AS n FROM ${table} WHERE location_id = ?`, locationId)?.n ?? 0);
    } catch {
      /* the module that owns the table is not loaded */
    }
  }
  return sum;
};

/** Fair-use meters of one sub-account (this month): used, limit (null = unlimited) and what happens above it. */
export function meters(app: App, locationId: string, key: PlanKey) {
  const s = cloudSettings(app);
  const fair = s.fair_use[key];
  const used = usageOf(app, locationId);
  return {
    ...Object.fromEntries(METRICS.map((m) => [m, { used: used[m], limit: fair[m], overage: s.overage[m] }])),
    storage_mb: { used: Math.round((storageUsedBytes(app, locationId) / MB) * 10) / 10, limit: fair.storage_mb, overage: 'block' as const },
  } as Record<'emails' | 'sms' | 'ai' | 'storage_mb', { used: number; limit: number | null; overage: string }>;
}

export function tenantSummary(app: App, t: Tenant) {
  const s = cloudSettings(app);
  const sub = tenantSub(app, t);
  const key = tenantPlanKey(app, t);
  const plan = sub ? planById(app, sub.plan_id) : undefined;
  const ent = entitlements(key, s);
  const locs = tenantLocationIds(app, t.id);
  const phase = phaseOf(t, sub);
  const interval = sub?.interval ?? 'month';
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    subdomain: s.cloud_domain ? `${t.slug}.${s.cloud_domain}` : null,
    location_id: t.location_id,
    plan: { key, name: PLAN_INFO[key].name, interval, price_cents: plan ? (interval === 'year' ? plan.price_year_cents : plan.price_month_cents) : 0, currency: plan?.currency ?? 'EUR' },
    phase,
    phase_label: PHASE_LABEL[phase],
    status: sub?.status ?? 'canceled',
    billing: sub?.billing ?? 'manual',
    stripe: !!sub?.stripe_customer,
    trial_end: sub?.trial_end ?? null,
    current_period_end: sub?.current_period_end ?? null,
    cancel_at_period_end: !!sub?.cancel_at_period_end,
    grace_until: sub?.grace_until ?? null,
    read_only: isReadOnly(sub?.status),
    comped: !!t.comped,
    comp_until: t.comp_until,
    deletion: t.deletion_at ? { at: t.deletion_at, reason: t.deletion_reason } : null,
    read_only_since: t.read_only_since,
    meters: meters(app, t.location_id, key),
    counts: { users: stockCount(app, t.location_id, 'users'), clients: Math.max(0, locs.length - 1) },
    entitlements: ent,
    support: { until: t.support_until, active: supportActive(t) },
    created_at: t.created_at,
  };
}


// --- Agentur: client sub-accounts carry a mirror of the tenant's billing state -----------------------------------------

/**
 * A client sub-account of an Agentur customer gets a price-less subscription row that copies the tenant's status, so the SaaS gate
 * (read-only), the banner and the per-account fair-use metering work there as well. The primary row stays the single truth.
 */
export function syncChildren(app: App, t: Tenant) {
  const sub = tenantSub(app, t);
  if (!sub) return;
  const want = {
    plan_id: CLIENT_PLAN_ID,
    interval: 'month' as const,
    billing: 'manual' as const,
    status: sub.status,
    // An expired trial without payment data says so on the client accounts too; a Stripe trial's old end date does not matter there.
    trial_end: sub.billing === 'manual' || sub.status === 'trialing' ? sub.trial_end : null,
    current_period_end: sub.current_period_end,
    cancel_at_period_end: sub.cancel_at_period_end,
    past_due_since: sub.past_due_since,
    grace_until: sub.grace_until,
    paused_at: sub.paused_at,
    canceled_at: sub.canceled_at,
    email: t.email,
  };
  for (const lid of tenantLocationIds(app, t.id)) {
    if (lid === t.location_id) continue;
    const cur = subscriptionOf(app, lid);
    if (cur && (Object.keys(want) as (keyof typeof want)[]).every((k) => (cur as any)[k] === want[k])) continue;
    upsertSubscription(app, { ...want, location_id: lid });
  }
}

/**
 * The hard delete: the Stripe subscription is ended, then every row, file and login of the customer goes, and the tenant row
 * stays as a tombstone without personal data (so the numbers – signups, churn – survive). Never touches admins.
 */
export async function eraseTenant(app: App, t: Tenant, why: string): Promise<{ rows: number; files: number }> {
  const sub = tenantSub(app, t);
  if (sub?.stripe_subscription && sub.status !== 'canceled' && stripeKeyOf(app)) await saasStripe(app, 'DELETE', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`).catch(() => undefined);
  const locs = tenantLocationIds(app, t.id);
  const users = app.db.all<{ user_id: string }>('SELECT m.user_id FROM cloud_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND u.role != ?', t.id, 'admin').map((r) => r.user_id);
  await sendCloudMail(app, 'deleted', t.email, { company: t.name }, { tenantId: t.id, dedupe: 'deleted' });
  const out = locs.length ? eraseLocations(app, locs) : { rows: 0, files: 0 };
  app.db.tx(() => {
    for (const uid of users) app.db.run('DELETE FROM users WHERE id = ?', uid);
    eraseUserRows(app, users);
    app.db.run('DELETE FROM cloud_invoices WHERE tenant_id = ?', t.id);
    app.db.run('DELETE FROM cloud_mails WHERE tenant_id = ?', t.id);
    app.db.run('DELETE FROM cloud_signups WHERE tenant_id = ? OR (email != ? AND email = ?)', t.id, '', t.email);
    app.db.run(`UPDATE cloud_events SET detail = '' WHERE tenant_id = ?`, t.id);
    app.db.run(`UPDATE cloud_acceptances SET user_id = NULL, ip = '' WHERE tenant_id = ?`, t.id);
    app.db.run(
      `UPDATE cloud_tenants SET name = '', email = '', owner_user_id = NULL, coupon = '', cancel_comment = '', notes = '', slug = ?, comped = 0, support_until = NULL, deletion_at = NULL, deleted_at = ?, updated_at = ? WHERE id = ?`,
      `x-${t.id}`,
      now(),
      now(),
      t.id,
    );
    logCloudEvent(app, t.id, 'deleted', why);
  });
  app.services.audit?.({ action: 'cloud.deleted', summary: `${why} (${out.rows} Zeilen, ${out.files} Dateien)`, actor: 'Cloud', entityId: t.id });
  return out;
}

// --- the module ---------------------------------------------------------------------------------------------------

export const cloudModule: Module = {
  name: 'cloud',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE cloud_tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '',
        location_id TEXT NOT NULL UNIQUE, owner_user_id TEXT, coupon TEXT NOT NULL DEFAULT '',
        comped INTEGER NOT NULL DEFAULT 0, comp_until TEXT, support_until TEXT,
        read_only_since TEXT, schedule_notified_at TEXT, deletion_at TEXT, deletion_reason TEXT NOT NULL DEFAULT '',
        cancel_reason TEXT NOT NULL DEFAULT '', cancel_comment TEXT NOT NULL DEFAULT '',
        trial_started_at TEXT, converted_at TEXT, notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE TABLE cloud_locations (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES cloud_tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'client', created_at TEXT NOT NULL
      );
      CREATE INDEX cloud_locations_tenant ON cloud_locations(tenant_id);
      CREATE TABLE cloud_members (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        tenant_id TEXT NOT NULL REFERENCES cloud_tenants(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'member', all_locations INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE INDEX cloud_members_tenant ON cloud_members(tenant_id);
      CREATE TABLE cloud_signups (
        id TEXT PRIMARY KEY, plan_key TEXT NOT NULL, interval TEXT NOT NULL DEFAULT 'month',
        company TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, password_hash TEXT NOT NULL DEFAULT '',
        google_sub TEXT NOT NULL DEFAULT '', coupon TEXT NOT NULL DEFAULT '', legal TEXT NOT NULL DEFAULT '{}',
        verify_hash TEXT NOT NULL DEFAULT '', verified_at TEXT, browser_hash TEXT NOT NULL DEFAULT '',
        google_state TEXT NOT NULL DEFAULT '', google_verifier TEXT NOT NULL DEFAULT '', google_nonce TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, tenant_id TEXT, location_id TEXT, user_id TEXT,
        error TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX cloud_signups_email ON cloud_signups(email);
      CREATE INDEX cloud_signups_verify ON cloud_signups(verify_hash);
      CREATE INDEX cloud_signups_session ON cloud_signups(session_id);
      CREATE TABLE cloud_acceptances (
        id TEXT PRIMARY KEY, signup_id TEXT, tenant_id TEXT, user_id TEXT, doc TEXT NOT NULL, version INTEGER NOT NULL,
        hash TEXT NOT NULL, at TEXT NOT NULL, ip TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX cloud_acceptances_tenant ON cloud_acceptances(tenant_id, doc);
      CREATE TABLE cloud_legal (
        doc TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (doc, version)
      );
      CREATE TABLE cloud_events (id TEXT PRIMARY KEY, tenant_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
      CREATE INDEX cloud_events_tenant ON cloud_events(tenant_id, at);
      CREATE INDEX cloud_events_type ON cloud_events(type, at);
      CREATE TABLE cloud_mails (tenant_id TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL DEFAULT '', sent_at TEXT NOT NULL, PRIMARY KEY (tenant_id, kind, ref));
      CREATE TABLE cloud_invoices (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES cloud_tenants(id) ON DELETE CASCADE, number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '', amount_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
        created TEXT NOT NULL, hosted_url TEXT NOT NULL DEFAULT '', pdf_url TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX cloud_invoices_tenant ON cloud_invoices(tenant_id, created);
      `,
    ],
  ],
  register(app) {
    if (!cloudEnabled(app)) return;
    const { router } = app;
    ensureLegal(app);
    seedStripeFromEnv(app);
    ensureCloudPlans(app);

    // The operator's admin logins are no part of a customer's team: not in pickers, assignments or notification audiences.
    app.services.hideUser = (u: { role?: string }, locationId: string) => u.role === 'admin' && !!tenantOfLocation(app, locationId);

    // …and the operator's own location list (/api/me) leaves out the customers' sub-accounts the customer has not opened for support:
    // no landing on a customer's account after login, no switcher with thousands of customers (the console is the list).
    app.services.hiddenLocations = (u: { role?: string }): Set<string> | undefined => {
      if (u.role !== 'admin') return undefined;
      const rows = app.db.all<{ id: string }>(
        'SELECT l.location_id AS id FROM cloud_locations l JOIN cloud_tenants t ON t.id = l.tenant_id WHERE t.deleted_at IS NULL AND (t.support_until IS NULL OR t.support_until <= ?)',
        new Date().toISOString(),
      );
      return new Set(rows.map((r) => r.id));
    };

    // The service's own domain and every sub-domain of it belong to the operator: customers log in on `<name>.<cloud domain>` (set at signup),
    // and nobody else may point a site or a help center at such a host (that host would then show their page instead of the login).
    app.services.domainReserved = (domain: string, ctx?: { user?: { role?: string } }): boolean => {
      const cd = cloudSettings(app).cloud_domain;
      return !!cd && (domain === cd || domain.endsWith(`.${cd}`)) && ctx?.user?.role !== 'admin';
    };

    app.services.cloud = {
      enabled: true,
      // `waitlist`: no signup and no payment (the /start page shows the waitlist form instead).
      info: () => ({ enabled: true, waitlist: cloudWaitlist(app), signup_url: '/start', pricing_url: '/cloud' }),
      tenantOfLocation: (lid: string) => tenantOfLocation(app, lid),
      tenantOfUser: (uid: string) => tenantOfUser(app, uid),
    };

    // --- guards ---------------------------------------------------------------------------------------------------
    /** Refuses what would take the sub-account over its plan's media storage (fair use). Also called by the video uploads of courses and communities. */
    const storageGate = (locationId: string, incoming: number) => {
      const t = tenantOfLocation(app, locationId);
      if (!t) return;
      const limit = cloudSettings(app).fair_use[tenantPlanKey(app, t)].storage_mb;
      if (limit !== null && storageUsedBytes(app, locationId) + incoming > limit * MB) throw new HttpError(403, `Speicher-Limit erreicht: dein Tarif enthält ${limit.toLocaleString('de-DE')} MB für Medien (Fair Use). Lösche Dateien oder schreib uns für mehr.`);
    };
    app.services.storageGate = storageGate;
    /** The same meter for gates that answer with their own words (public form uploads: modules/public-upload-quota.ts). */
    app.services.storageMeter = (locationId: string): { used: number; limit: number | null } | undefined => {
      const t = tenantOfLocation(app, locationId);
      if (!t) return undefined;
      const limit = cloudSettings(app).fair_use[tenantPlanKey(app, t)].storage_mb;
      return { used: storageUsedBytes(app, locationId), limit: limit === null ? null : limit * MB };
    };
    const AGENCY_CONTENT = /^\/api\/agency\/(contacts|opportunities|tasks|docs|invoices|privacy\/export|privacy\/erase)$/;
    const noConsent = () => new HttpError(403, 'Dieses Kunden-Konto ist nicht für den Support freigegeben. Der Kunde schaltet den Zugriff unter Einstellungen → Cloud-Konto frei.');
    app.guards.push((ctx: Ctx, auth: Auth) => {
      const u = ctx.user;
      if (!u) return;
      // 1. Operator side: customer data only with the customer's consent (see docs/cloud.md).
      if (u.role === 'admin') {
        if (auth === 'location' && ctx.locationId) {
          const t = tenantOfLocation(app, ctx.locationId);
          if (t && !supportActive(t)) throw noConsent();
        }
        // The operator's user management reaches a customer's login (set a password, reset 2FA, sign out, delete) or puts a login of their own
        // into a customer's sub-account: both are as good as opening the account, so both need the consent too.
        if (auth === 'admin' && ctx.method !== 'GET' && /^\/api\/users(\/|$)/.test(ctx.path)) {
          const own = ctx.params.id ? tenantOfUser(app, ctx.params.id) : undefined;
          if (own && !supportActive(own.tenant)) throw noConsent();
          for (const lid of Array.isArray(ctx.body?.locations) ? ctx.body.locations : []) {
            const t = tenantOfLocation(app, String(lid));
            if (t && !supportActive(t)) throw noConsent();
          }
        }
        if (auth === 'admin' && AGENCY_CONTENT.test(ctx.path)) {
          const lid = String(ctx.query.get('location_id') ?? ctx.body?.location_id ?? '');
          if (!lid) throw new HttpError(403, 'Im Cloud-Modus zeigt diese Liste nur einen Sub-Account: bitte einen auswählen (Kundendaten sind getrennt).');
          const t = tenantOfLocation(app, lid);
          if (t && !supportActive(t)) throw noConsent();
        }
        return;
      }
      // 2. Customer side: a tenant that is read-only changes nothing (billing and account routes stay open).
      if (auth !== 'location' || !ctx.locationId) return;
      const t = tenantOfLocation(app, ctx.locationId);
      if (!t) return;
      const sub = tenantSub(app, t);
      if (ctx.method !== 'GET' && isReadOnly(sub?.status) && !ctx.path.startsWith('/api/saas/account')) throw new HttpError(403, readOnlyMessage(sub!.status));
      // Media storage: fair use per sub-account – the base64 media upload and the raw audio of call analyses and telephony; the chunked video
      // uploads (courses, community) ask the same gate when they start (`app.services.storageGate`).
      if (ctx.method === 'POST' && ctx.path === '/api/uploads') storageGate(ctx.locationId, Math.floor((String(ctx.body?.data ?? '').length * 3) / 4));
      else if (ctx.method === 'POST' && (ctx.path === '/api/call-intel/upload' || ctx.path === '/api/telephony/audio') && ctx.rawBuffer) storageGate(ctx.locationId, ctx.rawBuffer.length);
    });

    // The operator's list of logins leaves out the customers' people (the consent decides, like for the sub-account lists).
    app.router.wrappers.push((route, next) =>
      route.method === 'GET' && route.pattern === '/api/users'
        ? async (ctx) => {
            const out = await next(ctx);
            return Array.isArray(out) ? out.filter((u: { id?: string }) => { const m = u?.id ? tenantOfUser(app, u.id) : undefined; return !m || supportActive(m.tenant); }) : out;
          }
        : next,
    );

    // --- the customer's own view -----------------------------------------------------------------------------------
    const planCards = () => {
      const s = cloudSettings(app);
      return PLAN_KEYS.map((k) => ({
        key: k,
        name: PLAN_INFO[k].name,
        tagline: PLAN_INFO[k].tagline,
        price_month_cents: priceFor(s, k, 'month'),
        price_year_cents: priceFor(s, k, 'year'),
        users: PLAN_INFO[k].users,
        white_label: PLAN_INFO[k].white_label,
        client_accounts: PLAN_INFO[k].client_accounts,
        highlights: PLAN_INFO[k].highlights,
        fair_use: s.fair_use[k],
      }));
    };
    app.services.cloud.planCards = planCards;

    router.get('/api/cloud/plans', 'user', () => ({ plans: planCards(), yearly_discount_percent: cloudSettings(app).yearly_discount_percent, price_note: cloudSettings(app).price_note, trial_days: cloudSettings(app).trial_days }));

    router.get('/api/cloud/me', 'user', (ctx) => {
      const m = tenantOfUser(app, ctx.user!.id);
      if (!m) return { customer: false };
      // A login for one client account of an Agentur: just whether the account can be written to, nothing about the tenant.
      if (m.role !== 'owner' && !m.all_locations) return { customer: true, limited: true, role: 'member', read_only: isReadOnly(tenantSub(app, m.tenant)?.status) };
      const sum = tenantSummary(app, m.tenant);
      return {
        customer: true,
        role: m.role,
        user: { id: ctx.user!.id, email: ctx.user!.email, name: ctx.user!.name },
        tenant: sum,
        support_email: cloudSupport(app),
        legal: { pending: pendingLegal(app, m.tenant.id) },
        status_url: cloudSettings(app).status_url,
        plan_key: sum.plan.key,
      };
    });
  },
};
