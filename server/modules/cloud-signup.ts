import type { Module } from '../core/app.js';
import { HttpError, redirect, type RawResult } from '../core/http.js';
import { hashPasswordAsync, id, normalizeEmail, now, sha256, token } from '../core/util.js';
import { ALL_AREAS, PLAN_INFO, entitlements, isDisposableEmail, isPlanKey, planIdOf, tenantSlug, type PlanKey } from '../services/cloud.js';
import { ACCEPTED_DOCS } from '../services/cloud-legal.js';
import { businessNote, checkBusiness, type Business } from '../services/cloud-b2b.js';
import { JwksCache, verifyIdToken } from '../services/jose.js';
import { buildAuthorizeUrl, fetchJson, type Fetcher } from '../services/oidc.js';
import { exchangeCode as oauthExchange, pkcePair } from '../services/oauth.js';
import { identityFromClaims, socialEndpoints, socialIssuerCheck } from '../services/social-login.js';
import { applySnapshot, validateSnapshot } from '../services/snapshots.js';
import type { Interval } from '../services/saas.js';
import { createLocation, startSession } from './core.js';
import { clientConfig } from './oauth-connect.js';
import {
  appLink,
  cloudEnabled,
  cloudSettings,
  fmtDay,
  grantOwnerHr,
  legalCurrent,
  logCloudEvent,
  recordAcceptance,
  sendCloudMail,
  starterContent,
  tenantById,
  type Tenant,
} from './cloud.js';
import { formTokenOk, formToken, pageCtx, pricingData, servePage } from './cloud-pages.js';
import { messagePage, signupPage, type SignupData } from '../services/cloud-pages.js';
import { fetchSubscription, fromStripeSub, logSaasEvent, planById, saasStripe, stripeKeyOf, upsertSubscription } from './saas.js';

/**
 * Self-serve signup of the hosted service. /start → e-mail verification (or Google, which verifies it) → Stripe Checkout
 * (a subscription with a trial; or none when the operator lets trials start without a card) → the tenant is
 * provisioned the moment Stripe confirms (webhook or the customer's return, whichever comes first) → the browser that
 * signed up is logged in and lands in /app. Abuse protection without a captcha: honeypot, a time token, a per-address
 * and per-mail rate limit, an optional disposable-mail blocklist. Acceptance of AGB, AVV and Datenschutz is stored with
 * the document versions.
 *
 * No account before the address is proven, and no password from before the proof (pre-hijack, docs/security-review-2026-10.md O-1):
 * the form's password only counts when the verification link is opened in the browser that sent the form (a cookie binds them);
 * in any other browser the link asks for the password itself. The first verification claims the link (afterwards it only goes on in
 * the browser that verified) and closes every other open sign-up for the address – their links, passwords and browser bindings die.
 *
 * Waitlist mode (PGHL_CLOUD_WAITLIST=1, or no Stripe key): modules/cloud-waitlist.ts wraps POST /start, the verification link and the
 * Google return and refuses them with 403 before anything here runs; GET /start shows the waitlist form (modules/cloud-pages.ts).
 */

const COOKIE = 'pghl_cloud';
const VERIFY_HOURS = 24;

interface Signup {
  id: string;
  plan_key: PlanKey;
  interval: Interval;
  company: string;
  name: string;
  email: string;
  password_hash: string;
  google_sub: string;
  coupon: string;
  legal: string;
  verify_hash: string;
  verified_at: string | null;
  browser_hash: string;
  google_state: string;
  google_verifier: string;
  google_nonce: string;
  status: string;
  session_id: string | null;
  tenant_id: string | null;
  location_id: string | null;
  user_id: string | null;
  error: string;
  ip: string;
  created_at: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

export const cloudSignupModule: Module = {
  name: 'cloud-signup',
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;
    /** Per-address throttles (signups per hour, mails to one address, verification clicks). */
    const hits = new Map<string, number[]>();
    function throttled(key: string, max: number, windowMs = 60 * 60_000): boolean {
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      list.push(t);
      hits.set(key, list);
      if (hits.size > 20_000) hits.clear();
      return list.length > max;
    }
    Object.assign(app.services.cloud, { resetLimits: () => hits.clear() });

    const checkMail = (title = 'Bitte prüfe dein Postfach') =>
      servePage(messagePage(pageCtx(app), { title, text: 'Wir haben dir eine E-Mail geschickt. Mit einem Klick auf den Link darin bestätigst du deine Adresse – danach geht es direkt weiter. Der Link gilt 24 Stunden.', action: ['/cloud', 'Zurück zu den Preisen'] }));
    const message = (title: string, text: string, status = 200, o: { action?: [string, string]; head?: string; error?: string; method?: { action: string; label: string; passwords?: boolean } } = {}) => servePage(messagePage(pageCtx(app), { title, text, ...o }), status);

    // --- Stripe: the Checkout of a verified signup -----------------------------------------------------------------
    /** A promotion code of the operator's Stripe account, or null when it does not exist / is not active. */
    async function promotion(code: string): Promise<string | null> {
      if (!code || !stripeKeyOf(app)) return null;
      try {
        const r = await saasStripe(app, 'GET', '/v1/promotion_codes', { code, active: true, limit: 1 });
        return r?.data?.[0]?.id ?? null;
      } catch {
        return null;
      }
    }

    async function createCheckout(signup: Signup): Promise<string> {
      const s = cloudSettings(app);
      const plan = planById(app, planIdOf(signup.plan_key));
      if (!plan) throw new Error('Tarif nicht gefunden');
      const price = await app.services.saasPriceId(plan, signup.interval);
      const base = app.baseUrl();
      const meta = { cloud_signup_id: signup.id, plan_id: plan.id, plan_key: signup.plan_key, interval: signup.interval };
      const promo = await promotion(signup.coupon);
      const params: Record<string, any> = {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        customer_email: signup.email,
        client_reference_id: signup.id,
        success_url: `${base}/start/done?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/start?plan=${signup.plan_key}&interval=${signup.interval}&canceled=1`,
        metadata: meta,
        subscription_data: { metadata: meta, ...(s.trial_days > 0 ? { trial_period_days: s.trial_days } : {}) },
        billing_address_collection: 'required',
        locale: 'de',
        ...(promo ? { discounts: [{ promotion_code: promo }] } : { allow_promotion_codes: true }),
        ...(s.stripe_tax ? { automatic_tax: { enabled: true } } : {}),
        ...(s.tax_id_collection ? { tax_id_collection: { enabled: true } } : {}),
      };
      const session = await saasStripe(app, 'POST', '/v1/checkout/sessions', params);
      if (!session?.id || !session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
      db.run(`UPDATE cloud_signups SET session_id = ?, status = 'checkout' WHERE id = ?`, session.id, signup.id);
      return String(session.url);
    }

    // --- provisioning --------------------------------------------------------------------------------------------------
    /** Tenant, sub-account, owner login, subscription row, acceptances – all or nothing. */
    function provision(signup: Signup, stripe: { sub?: any; subId?: string; customer?: string } | null) {
      const s = cloudSettings(app);
      const plan = planById(app, planIdOf(signup.plan_key));
      if (!plan) throw new Error('Tarif nicht gefunden');
      // Never an account for an address nobody has proven (e-mail link or Google).
      if (!signup.verified_at) throw new Error('Die E-Mail-Adresse ist noch nicht bestätigt');
      const out = db.tx(() => {
        if (db.get('SELECT id FROM users WHERE email = ?', signup.email)) throw new Error('Für diese E-Mail gibt es schon ein Konto');
        const slug = tenantSlug(signup.company, (x) => !!db.get('SELECT 1 AS x FROM cloud_tenants WHERE slug = ?', x));
        const settings: Record<string, any> = { email: { provider: 'log' }, sms: { provider: 'log' } };
        if (s.cloud_domain) settings.branding = { app_domain: `${slug}.${s.cloud_domain}` };
        const loc = createLocation(db, signup.company, 'Europe/Berlin', { email: signup.email, settings });
        const snap = s.default_snapshot_id ? db.get('SELECT * FROM snapshots WHERE id = ?', s.default_snapshot_id) : undefined;
        let snapped = false;
        if (snap) {
          try {
            const data = validateSnapshot(JSON.parse(snap.data));
            if (data.pipelines.length) db.run('DELETE FROM pipelines WHERE location_id = ?', loc.id);
            applySnapshot(app, loc.id, data, { activateWorkflows: false });
            snapped = true;
          } catch (e) {
            logSaasEvent(app, loc.id, 'snapshot_failed', (e as Error).message);
          }
        }
        if (!snapped) starterContent(app, loc.id);
        const userId = id();
        db.insert('users', { id: userId, email: signup.email, name: signup.name || signup.company, password_hash: signup.password_hash || `!unset-${token(12)}`, role: 'member', locations: [loc.id], permissions: ALL_AREAS, created_at: now(), password_set: signup.password_hash ? 1 : 0 });
        grantOwnerHr(app, loc.id, userId);
        if (signup.google_sub) db.insert('auth_identities', { id: id(), user_id: userId, provider: 'google', subject: signup.google_sub, email: signup.email, name: signup.name, created_at: now(), last_login_at: now() });
        const tid = id();
        const trialEnd = !stripe && s.trial_days > 0 ? new Date(Date.now() + s.trial_days * 864e5).toISOString() : null;
        db.insert('cloud_tenants', { id: tid, name: signup.company, slug, email: signup.email, location_id: loc.id, owner_user_id: userId, coupon: signup.coupon, trial_started_at: s.trial_days > 0 ? now() : null, created_at: now(), updated_at: now() });
        db.insert('cloud_locations', { location_id: loc.id, tenant_id: tid, role: 'primary', created_at: now() });
        db.insert('cloud_members', { user_id: userId, tenant_id: tid, role: 'owner', all_locations: 1, created_at: now() });
        const fields = stripe?.sub
          ? fromStripeSub(app, stripe.sub)
          : stripe
            ? { billing: 'stripe' as const, status: s.trial_days > 0 ? ('trialing' as const) : ('active' as const), stripe_subscription: stripe.subId ?? '', stripe_customer: stripe.customer ?? '' }
            : { billing: 'manual' as const, status: s.trial_days > 0 ? ('trialing' as const) : ('active' as const), trial_end: trialEnd, current_period_end: trialEnd };
        upsertSubscription(app, { ...fields, interval: signup.interval, location_id: loc.id, plan_id: plan.id, email: signup.email });
        recordAcceptance(app, { signupId: signup.id, tenantId: tid, userId, ip: signup.ip, versions: JSON.parse(signup.legal || '{}') });
        const b2b = (JSON.parse(signup.legal || '{}') as { b2b?: Business }).b2b;
        if (b2b) logCloudEvent(app, tid, 'b2b_confirmed', businessNote(b2b));
        db.run(`UPDATE cloud_signups SET status = 'done', tenant_id = ?, location_id = ?, user_id = ?, password_hash = '', completed_at = ?, error = '' WHERE id = ?`, tid, loc.id, userId, now(), signup.id);
        logCloudEvent(app, tid, 'provisioned', `${signup.company} · ${PLAN_INFO[signup.plan_key].name} (${signup.interval === 'year' ? 'jährlich' : 'monatlich'}${stripe ? '' : ', ohne Zahlungsmittel'})`);
        if (s.trial_days > 0) logCloudEvent(app, tid, 'trial_started', `${s.trial_days} Tage`);
        else logCloudEvent(app, tid, 'subscribed', PLAN_INFO[signup.plan_key].name);
        return { tid, loc, userId };
      });
      app.services.audit?.({ action: 'cloud.provisioned', summary: `${signup.company} (${signup.plan_key})`, userId: out.userId, locationId: out.loc.id, actor: 'Cloud-Anmeldung' });
      return out;
    }

    function welcome(tid: string, signup: Signup) {
      const t = tenantById(app, tid) as Tenant;
      const sub = db.get<{ trial_end: string | null }>('SELECT trial_end FROM saas_subscriptions WHERE location_id = ?', t.location_id);
      const list = ['Firmendaten ergänzen: Einstellungen → Firma', 'E-Mail-Versand einrichten: Einstellungen → E-Mail & SMS', 'Erste Kontakte anlegen oder importieren', 'Die Akademie öffnen: kurze Touren für jeden Bereich'];
      if (entitlements(signup.plan_key, cloudSettings(app)).users !== 1) list.push('Kolleginnen und Kollegen einladen: Einstellungen → Cloud-Konto → Team');
      if (signup.plan_key === 'agency') list.push('Eigenes Branding festlegen und den ersten Kunden-Account anlegen: Einstellungen → Cloud-Konto');
      return sendCloudMail(app, 'welcome', signup.email, { name: signup.name, company: signup.company, plan: PLAN_INFO[signup.plan_key].name, trial_end: sub?.trial_end ? fmtDay(sub.trial_end) : '', link: appLink(app, '/app'), checklist: list }, { tenantId: tid, dedupe: 'welcome' });
    }

    /** Stripe confirmed a Checkout (webhook or the customer's return). Safe to call twice. */
    async function completeSignup(session: any) {
      const signup = db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', String(session?.metadata?.cloud_signup_id ?? ''));
      if (!signup) return { handled: 'unknown_signup' };
      if (signup.status === 'done') return { handled: 'duplicate', locationId: signup.location_id };
      if (session.status && session.status !== 'complete') return { handled: 'not_complete' };
      if (!db.run(`UPDATE cloud_signups SET status = 'provisioning', session_id = COALESCE(session_id, ?) WHERE id = ? AND status IN ('pending', 'verified', 'checkout', 'failed')`, session.id ?? null, signup.id).changes) return { handled: 'in_progress' };
      const subObj = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      const subId = String(subObj?.id ?? session.subscription ?? '');
      const customer = String(typeof session.customer === 'object' ? (session.customer?.id ?? '') : (session.customer ?? ''));
      try {
        const sub = subObj ?? (subId ? await fetchSubscription(app, subId) : null);
        const r = provision(signup, { sub, subId, customer });
        void welcome(r.tid, signup);
        return { handled: 'account_created', locationId: r.loc.id, userId: r.userId };
      } catch (e) {
        const msg = (e as Error).message.slice(0, 300);
        db.run(`UPDATE cloud_signups SET status = 'failed', error = ? WHERE id = ?`, msg, signup.id);
        logCloudEvent(app, null, 'provision_failed', `${signup.company} <${signup.email}>: ${msg}`);
        // Never leave a customer paying for an account that does not exist.
        if (subId && stripeKeyOf(app)) await saasStripe(app, 'DELETE', `/v1/subscriptions/${encodeURIComponent(subId)}`).catch(() => undefined);
        throw e;
      }
    }
    app.services.cloudCompleteSignup = completeSignup;

    /** The signup is verified: pay (Stripe) or – a trial without card – start at once. */
    async function continueSignup(signup: Signup): Promise<RawResult> {
      const s = cloudSettings(app);
      const needsStripe = s.card_required || s.trial_days === 0;
      if (needsStripe) {
        if (!stripeKeyOf(app)) {
          logCloudEvent(app, null, 'signup_blocked', 'Stripe ist nicht eingerichtet (Agentur → SaaS → Einstellungen)');
          return message('Bezahlung nicht möglich', 'Die Online-Bezahlung ist gerade nicht eingerichtet. Bitte melde dich beim Anbieter.', 503);
        }
        try {
          return redirect(await createCheckout(signup), 303);
        } catch (e) {
          db.run(`UPDATE cloud_signups SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 300), signup.id);
          return message('Bezahlung gerade nicht möglich', (e as Error).message, 502, { action: ['/cloud', 'Zurück'] });
        }
      }
      if (!db.run(`UPDATE cloud_signups SET status = 'provisioning' WHERE id = ? AND status IN ('pending', 'verified', 'failed')`, signup.id).changes) return redirect(`/start/done?s=${signup.id}`, 303);
      try {
        const r = provision(signup, null);
        void welcome(r.tid, signup);
      } catch (e) {
        db.run(`UPDATE cloud_signups SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 300), signup.id);
        return message('Das hat nicht geklappt', (e as Error).message, 409, { action: ['/app', 'Zur Anmeldung'] });
      }
      return redirect(`/start/done?s=${signup.id}`, 303);
    }

    // --- the form -------------------------------------------------------------------------------------------------------
    router.post('/start', 'public', async (ctx) => {
      const s = cloudSettings(app);
      const b = ctx.body ?? {};
      const via = b.via === 'google' ? 'google' : 'email';
      const val = (k: string, max = 200) => String(b[k] ?? '').trim().slice(0, max);
      const values = { plan: val('plan', 20), interval: val('interval', 10) === 'year' ? 'year' : 'month', company: val('company', 130), name: val('name', 130), email: normalizeEmail(val('email', 210)), coupon: val('coupon', 70), vat_id: val('vat_id', 30), business: b.business ? '1' : '' };
      const fail = (error: string, status = 400) => {
        const d: SignupData = { ...pricingData(app), values, error, token: formToken(app), google: !!googleReady() };
        return servePage(signupPage(pageCtx(app), d), status);
      };
      if (!s.signup_open) return fail('Neue Anmeldungen sind gerade pausiert.', 503);
      // Bots fill the hidden field: answer like a success, do nothing.
      if (String(b.website ?? '').trim()) return checkMail();
      if (!isPlanKey(values.plan)) return fail('Bitte einen Tarif wählen.');
      if (values.company.length < 2 || values.company.length > 120) return fail('Bitte den Firmennamen angeben (2 bis 120 Zeichen).');
      if (values.name.length > 120) return fail('Der Name ist zu lang.');
      // B2B only (cloud settings, default on): a VAT ID or the confirmation of ordering as a business.
      const business = checkBusiness(b, s.b2b_only);
      if (business.error) return fail(business.error);
      if (via === 'email') {
        if (!EMAIL.test(values.email)) return fail('Bitte eine gültige E-Mail-Adresse angeben.');
        if (s.block_disposable && isDisposableEmail(values.email, s.extra_blocked_domains)) return fail('Wegwerf-Adressen sind nicht erlaubt – bitte nimm deine echte E-Mail-Adresse.');
      }
      const password = String(b.password ?? '');
      if (via === 'email' && (password.length < 8 || password.length > 200)) return fail('Das Passwort braucht 8 bis 200 Zeichen.');
      for (const doc of ACCEPTED_DOCS) if (!b[doc]) return fail('Bitte AGB und AVV akzeptieren und die Datenschutzerklärung bestätigen.');
      if (values.coupon && !/^[A-Za-z0-9_-]{1,60}$/.test(values.coupon)) return fail('Der Gutscheincode ist ungültig.');
      // The time token comes after the field checks: someone who sends the empty form at once sees what is missing, not "too fast".
      // An incomplete form changes nothing; every submission that would sign up (or go on to Google) still needs a valid token.
      if (!formTokenOk(app, String(b.t ?? ''))) return fail('Das ging zu schnell oder die Seite ist veraltet – bitte noch einmal absenden.');
      if (throttled(`start:${ctx.ip}`, s.signups_per_ip_hour)) return fail('Zu viele Versuche von dieser Adresse – bitte in einer Stunde noch einmal.', 429);
      if (values.coupon && stripeKeyOf(app) && !(await promotion(values.coupon))) return fail('Der Gutscheincode ist unbekannt oder abgelaufen.');
      // The business confirmation rides along with the accepted versions (recordAcceptance reads only the documents).
      const legal = { ...Object.fromEntries(ACCEPTED_DOCS.map((d) => [d, legalCurrent(app, d).version])), ...(business.data ? { b2b: business.data } : {}) };
      const base = { id: id(), plan_key: values.plan, interval: values.interval, company: values.company, name: values.name, coupon: values.coupon, legal: JSON.stringify(legal), ip: ctx.ip, created_at: now() };

      if (via === 'google') {
        if (!googleReady()) return fail('Die Anmeldung mit Google ist nicht eingerichtet.');
        const browser = token(24);
        const state = token(24);
        const nonce = token(24);
        const { verifier, challenge } = pkcePair();
        db.insert('cloud_signups', { ...base, email: '', browser_hash: sha256(browser), google_state: sha256(state), google_verifier: verifier, google_nonce: nonce, status: 'pending' });
        ctx.setCookie(COOKIE, browser, { maxAge: 24 * 3600 });
        const cfg = clientConfig(app, 'google')!;
        const ep = socialEndpoints('google');
        return redirect(buildAuthorizeUrl(ep.authorize, { clientId: cfg.client_id, redirectUri: `${app.baseUrl()}/start/google/callback`, scope: ep.scope, state, nonce, challenge, extra: ep.extra }), 303);
      }

      // Same answer whether or not the address has an account (same cookie, same hashing work): nobody can probe for customers.
      // The cookie binds the form's password to this browser – the link opened anywhere else asks for a password of its own.
      const browser = token(24);
      ctx.setCookie(COOKIE, browser, { maxAge: VERIFY_HOURS * 3600 });
      const passwordHash = await hashPasswordAsync(password);
      if (db.get('SELECT id FROM users WHERE email = ?', values.email)) {
        if (!throttled(`exists:${values.email}`, 2)) void sendCloudMail(app, 'account_exists', values.email, { link: appLink(app, '/app') });
        return checkMail();
      }
      const recent = Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM cloud_signups WHERE email = ? AND created_at > ?`, values.email, new Date(Date.now() - 3600_000).toISOString())?.n ?? 0);
      if (recent >= 3) return checkMail();
      const verify = token(32);
      db.insert('cloud_signups', { ...base, email: values.email, password_hash: passwordHash, browser_hash: sha256(browser), verify_hash: sha256(verify), status: 'pending' });
      void sendCloudMail(app, 'verify', values.email, { name: values.name, company: values.company, link: appLink(app, `/start/verify/${verify}`) });
      return checkMail();
    });

    // --- e-mail verification: a button, not a GET with side effects (mail scanners open links) ----------------------
    const byVerify = (t: string): Signup | undefined => (/^[A-Za-z0-9_-]{20,100}$/.test(t) ? db.get<Signup>('SELECT * FROM cloud_signups WHERE verify_hash = ?', sha256(t)) : undefined);
    const stale = (s: Signup) => new Date(s.created_at).getTime() < Date.now() - VERIFY_HOURS * 3600_000;
    const expired = () => message('Link abgelaufen', 'Dieser Link ist nicht mehr gültig. Bitte starte die Anmeldung noch einmal.', 410, { action: ['/start', 'Neu anmelden'] });
    /** The browser that sent the form (before the proof) or that verified (after it). */
    const ownBrowser = (ctx: { cookies: Record<string, string> }, s: Signup) => !!s.browser_hash && !!ctx.cookies[COOKIE] && sha256(ctx.cookies[COOKIE]) === s.browser_hash;
    const used = () => message('Link schon benutzt', 'Diese Adresse ist schon bestätigt. Weiter geht es nur in dem Browser, in dem sie bestätigt wurde – oder du startest die Anmeldung neu.', 410, { action: ['/start', 'Neu anmelden'] });
    /** The verification page: the form's password counts only in the browser that sent the form; anywhere else the person sets it here. */
    const verifyPage = (t: string, s: Signup, own: boolean, error = '', status = 200) =>
      own && s.password_hash
        ? message('Fast geschafft', `Bestätige, dass ${s.email} dir gehört – danach richten wir „${s.company}“ ein.`, status, { error, method: { action: `/start/verify/${t}`, label: 'E-Mail bestätigen und weiter' } })
        : message('Fast geschafft', `Bestätige, dass ${s.email} dir gehört, und lege dein Passwort fest – danach richten wir „${s.company}“ ein. Ein Passwort, das vorher im Anmeldeformular eingegeben wurde, gilt nicht.`, status, { error, method: { action: `/start/verify/${t}`, label: 'Passwort speichern und weiter', passwords: true } });
    /** Every other open sign-up for the address dies with the first verification: links, passwords and browser bindings. Those already at Stripe stay – provisioning refuses a second account and cancels their subscription. */
    const closeOthers = (email: string, keep: string) =>
      db.run(`UPDATE cloud_signups SET status = 'superseded', password_hash = '', verify_hash = '', browser_hash = '', google_state = '', error = 'Durch eine spätere Bestätigung der Adresse ersetzt' WHERE email = ? AND id <> ? AND status IN ('pending', 'verified', 'failed') AND session_id IS NULL`, email, keep);

    router.get('/start/verify/:token', 'public', (ctx) => {
      const s = byVerify(ctx.params.token);
      if (!s || stale(s) || s.status === 'superseded') return expired();
      if (s.status === 'done') return message('Dein Konto ist schon bereit', 'Du hast diese Adresse schon bestätigt. Melde dich einfach an.', 200, { action: ['/app', 'Zur Anmeldung'] });
      const own = ownBrowser(ctx, s);
      if (s.verified_at) return own ? message('Adresse bestätigt', 'Es geht weiter, wo du aufgehört hast.', 200, { method: { action: `/start/verify/${ctx.params.token}`, label: 'Weiter' } }) : used();
      return verifyPage(ctx.params.token, s, own);
    });
    router.post('/start/verify/:token', 'public', async (ctx) => {
      if (throttled(`verify:${ctx.ip}`, 30)) return message('Zu viele Versuche', 'Bitte warte ein paar Minuten.', 429);
      const s = byVerify(ctx.params.token);
      if (!s || stale(s) || s.status === 'superseded') return expired();
      if (s.status === 'done') return message('Dein Konto ist schon bereit', 'Melde dich einfach an.', 200, { action: ['/app', 'Zur Anmeldung'] });
      if (db.get('SELECT id FROM users WHERE email = ?', s.email)) return message('Für diese Adresse gibt es schon ein Konto', 'Bitte melde dich an.', 409, { action: ['/app', 'Zur Anmeldung'] });
      const own = ownBrowser(ctx, s);
      // Verified before (e.g. the payment page failed): only the browser that verified goes on – nobody else can reuse the link.
      if (s.verified_at) return own ? continueSignup(s) : used();
      let passwordHash = s.password_hash;
      if (!own || !passwordHash) {
        const b = ctx.body ?? {};
        const pw = String(b.password ?? '');
        if (pw.length < 8 || pw.length > 200) return verifyPage(ctx.params.token, s, false, 'Das Passwort braucht 8 bis 200 Zeichen.', 400);
        if (pw !== String(b.password2 ?? '')) return verifyPage(ctx.params.token, s, false, 'Die beiden Passwörter sind nicht gleich.', 400);
        passwordHash = await hashPasswordAsync(pw);
      }
      // Claim the link: of two parallel clicks only one verifies (and sets the password).
      const browser = token(24);
      if (!db.run(`UPDATE cloud_signups SET verified_at = ?, browser_hash = ?, password_hash = ?, status = 'verified' WHERE id = ? AND verified_at IS NULL AND status = 'pending'`, now(), sha256(browser), passwordHash, s.id).changes) return used();
      closeOthers(s.email, s.id);
      ctx.setCookie(COOKIE, browser, { maxAge: 24 * 3600 });
      return continueSignup(db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', s.id)!);
    });

    // --- Google: verifies the address itself -------------------------------------------------------------------------
    const googleReady = () => !!clientConfig(app, 'google');
    app.services.cloudGoogleReady = googleReady;
    const fetcher = (): typeof fetch => app.services.ssoFetch ?? fetch;
    const jwks = new JwksCache((url) => fetchJson(fetcher() as Fetcher, url));

    router.get('/start/google/callback', 'public', async (ctx) => {
      const q = Object.fromEntries(ctx.query);
      const state = String(q.state ?? '');
      const signup = state && state.length < 200 ? db.get<Signup>(`SELECT * FROM cloud_signups WHERE google_state = ? AND status = 'pending'`, sha256(state)) : undefined;
      const cookie = ctx.cookies[COOKIE];
      if (!signup || !cookie || sha256(cookie) !== signup.browser_hash || stale(signup)) return message('Anmeldung abgelaufen', 'Bitte starte die Anmeldung noch einmal.', 400, { action: ['/start', 'Neu anmelden'] });
      db.run(`UPDATE cloud_signups SET google_state = '' WHERE id = ?`, signup.id);
      if (q.error) return message('Anmeldung abgebrochen', 'Du hast die Anmeldung mit Google abgebrochen. Du kannst es mit E-Mail und Passwort versuchen.', 400, { action: ['/start', 'Zurück'] });
      try {
        const cfg = clientConfig(app, 'google');
        if (!cfg) throw new Error('Die Google-App fehlt');
        const ep = socialEndpoints('google');
        const t = await oauthExchange(fetcher(), 'google', cfg, { code: String(q.code ?? ''), verifier: signup.google_verifier, redirectUri: `${app.baseUrl()}/start/google/callback`, scopes: ['openid', 'email', 'profile'] });
        if (!t.id_token) throw new Error('Google hat kein ID-Token geliefert');
        const claims = await verifyIdToken(t.id_token, jwks, ep.jwks!, { issuer: socialIssuerCheck('google'), audience: cfg.client_id, nonce: signup.google_nonce });
        const ident = identityFromClaims('google', claims);
        if (!ident.email || !ident.emailVerified) throw new Error('Google hat keine bestätigte E-Mail-Adresse übermittelt');
        if (db.get('SELECT id FROM users WHERE email = ?', ident.email)) return message('Für diese Adresse gibt es schon ein Konto', `${ident.email} hat schon ein Konto. Bitte melde dich an.`, 409, { action: ['/app', 'Zur Anmeldung'] });
        db.run(`UPDATE cloud_signups SET email = ?, name = CASE WHEN name = '' THEN ? ELSE name END, google_sub = ?, verified_at = ?, status = 'verified' WHERE id = ?`, ident.email, ident.name.slice(0, 120), ident.subject, now(), signup.id);
        // Google proved the address: open sign-ups somebody else started for it (with a password of their choosing) end here.
        closeOthers(ident.email, signup.id);
        return continueSignup(db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', signup.id)!);
      } catch (e) {
        return message('Anmeldung mit Google fehlgeschlagen', (e as Error).message.slice(0, 200), 400, { action: ['/start', 'Zurück'] });
      }
    });

    // --- back from Stripe (or from a trial without card): log the browser that signed up in ---------------------------
    router.get('/start/done', 'public', async (ctx) => {
      const sid = String(ctx.query.get('session_id') ?? '');
      const own = String(ctx.query.get('s') ?? '');
      let signup = /^cs_[A-Za-z0-9_]+$/.test(sid) ? db.get<Signup>('SELECT * FROM cloud_signups WHERE session_id = ?', sid) : /^[A-Za-z0-9]{16}$/.test(own) ? db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', own) : undefined;
      if (!signup) return message('Danke!', 'Wir richten dein Konto ein. Du bekommst gleich eine E-Mail.', 200, { action: ['/app', 'Zur Anmeldung'] });
      if (sid && ['checkout', 'verified', 'failed'].includes(signup.status)) {
        try {
          const session = await saasStripe(app, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sid)}`, { expand: ['subscription'] });
          if (session?.metadata?.cloud_signup_id === signup.id && session.status === 'complete') await completeSignup(session);
        } catch (e) {
          console.error('[cloud] Rückkehr prüfen', (e as Error).message);
        }
        signup = db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', signup.id)!;
      }
      if (signup.status === 'done') {
        const cookie = ctx.cookies[COOKIE];
        const user = signup.user_id ? db.get('SELECT * FROM users WHERE id = ?', signup.user_id) : undefined;
        if (user && cookie && sha256(cookie) === signup.browser_hash) {
          ctx.setCookie(COOKIE, '', { maxAge: 0 });
          startSession(ctx, app, user.id);
          app.services.audit?.({ ctx, action: 'login', summary: `${user.email} (Cloud-Anmeldung)`, userId: user.id, actor: user.name });
          return redirect('/app', 303);
        }
        return message('Dein Konto ist bereit', `Melde dich mit ${signup.email} an – wir haben dir außerdem eine E-Mail geschickt.`, 200, { action: ['/app', 'Zur Anmeldung'] });
      }
      if (signup.status === 'failed') return message('Das hat nicht geklappt', signup.error || 'Dein Konto konnte nicht angelegt werden. Eine Zahlung wird nicht abgebucht – bitte versuche es noch einmal oder melde dich beim Anbieter.', 409, { action: ['/start', 'Noch einmal'] });
      return message('Einen Moment …', 'Wir bestätigen gerade deine Zahlung und richten dein Konto ein. Diese Seite lädt sich von selbst neu.', 200, { head: '<meta http-equiv="refresh" content="3">' });
    });

    // --- housekeeping: unfinished signups do not stay around ---------------------------------------------------------
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 3600_000) return;
      last = Date.now();
      db.run(`DELETE FROM cloud_signups WHERE status IN ('pending', 'verified', 'checkout', 'superseded') AND created_at < ?`, new Date(Date.now() - 7 * 864e5).toISOString());
      db.run(`DELETE FROM cloud_signups WHERE status = 'failed' AND created_at < ?`, new Date(Date.now() - 30 * 864e5).toISOString());
    });

    // --- the operator re-runs a signup whose provisioning failed ---------------------------------------------------------
    router.get('/api/cloud/console/signups', 'admin', () =>
      db.all(`SELECT id, plan_key, interval, company, email, status, error, created_at, completed_at FROM cloud_signups ORDER BY created_at DESC LIMIT 100`),
    );
    router.post('/api/cloud/console/signups/:id/retry', 'admin', async (ctx) => {
      const s = db.get<Signup>('SELECT * FROM cloud_signups WHERE id = ?', ctx.params.id);
      if (!s) throw new HttpError(404, 'Anmeldung nicht gefunden');
      if (s.status !== 'failed' || !s.session_id) throw new HttpError(400, 'Nur fehlgeschlagene Anmeldungen mit Zahlung lassen sich wiederholen');
      const session = await saasStripe(app, 'GET', `/v1/checkout/sessions/${encodeURIComponent(s.session_id)}`, { expand: ['subscription'] });
      return completeSignup(session);
    });
  },
};
