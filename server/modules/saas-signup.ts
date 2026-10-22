import { SESSION_COOKIE, type LocationRow, type Module } from '../core/app.js';
import { HttpError, bad, html, notFound, redirect, type Ctx } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { PERMISSIONS } from '../core/permissions.js';
import { escapeHtml } from '../core/template.js';
import { hashPasswordAsync, id, normalizeEmail, now, sha256, token } from '../core/util.js';
import { deliverEmail, type OutMail } from '../services/messaging.js';
import { LIMITS, intervalsOf, isFree, limitOf, type Interval, type LimitKey, type Plan } from '../services/saas.js';
import { isCloudPlanId } from '../services/cloud.js';
import { applySnapshot, validateSnapshot } from '../services/snapshots.js';
import { getBranding } from './agency.js';
import { cloudEnabled } from './cloud.js';
import { createLocation } from './core.js';
import { fetchSubscription, fromStripeSub, logSaasEvent, planById, saasSettings, saasStripe, stripeKeyOf, upsertSubscription } from './saas.js';

/**
 * Public self-signup for SaaS mode: /signup lists the agency's public plans (in the agency's
 * white-label look, also on its app domain), the customer picks one and pays in Stripe Checkout
 * (subscription, optional trial). When Stripe confirms – by webhook or when the customer comes
 * back – a new sub-account is created from the plan's snapshot, the customer gets a login and an
 * invite e-mail, and the browser that signed up goes straight to "set your password" → /app.
 * Free plans skip Stripe. The plans of the hosted cloud (cloud-solo|team|agency and the client plan, kept in the same table) are
 * never offered or accepted here – they belong to /start (modules/cloud-signup.ts) and its waitlist mode.
 */

const SIGNUP_COOKIE = 'pghl_signup';
const INVITE_DAYS = 7;
const SESSION_DAYS = 30;

/** Per-IP throttle for signups (each paid one is a Stripe call). */
const hits = new Map<string, number[]>();
function throttled(key: string, max: number, windowMs = 60 * 60_000): boolean {
  const t = Date.now();
  const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
  list.push(t);
  hits.set(key, list);
  if (hits.size > 20_000) hits.clear();
  return list.length > max;
}

const euro = (cents: number, currency: string) => {
  const s = new Intl.NumberFormat('de-DE', { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100);
  return s;
};
const n = (v: number) => v.toLocaleString('de-DE');

const SIGNUP_CSS = `<style>
.saas { max-width: 1040px; margin: 0 auto; padding: 36px 16px 56px; }
.saas .brandbar { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; margin-bottom: 28px; }
.saas .brandbar img { max-height: 40px; max-width: 180px; }
.saas .brandbar .dot { width: 34px; height: 34px; border-radius: 9px; background: var(--brand); color: #fff; display: grid; place-items: center; }
.saas h1 { font-size: 34px; letter-spacing: -.02em; margin: 0 0 8px; }
.saas .lead { color: var(--muted); font-size: 17px; margin: 0 0 22px; max-width: 640px; }
.saas .interval { display: inline-flex; background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 4px; margin-bottom: 18px; }
.saas .interval label { position: relative; margin: 0; font-weight: 600; font-size: 14px; padding: 7px 16px; border-radius: 999px; cursor: pointer; display: flex; gap: 6px; align-items: center; }
.saas .interval input, .saas .plan input { position: absolute; top: 0; left: 0; width: 1px; height: 1px; margin: 0; padding: 0; opacity: 0; pointer-events: none; }
.saas .interval label:has(input:checked) { background: var(--brand); color: #fff; }
.saas .save { font-size: 12px; font-weight: 600; color: #047857; background: #d1fae5; border-radius: 999px; padding: 1px 8px; }
.saas .interval label:has(input:checked) .save { background: rgba(255,255,255,.22); color: #fff; }
.saas .plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-bottom: 22px; }
.saas .plan { position: relative; margin: 0; font-weight: 400; cursor: pointer; display: block; }
.saas .plan-body { height: 100%; background: #fff; border: 2px solid var(--line); border-radius: 16px; padding: 20px; transition: border-color .15s, box-shadow .15s; }
.saas .plan input:checked + .plan-body { border-color: var(--brand); box-shadow: 0 8px 24px rgba(15, 23, 42, .08); }
.saas .plan input:focus-visible + .plan-body { outline: 3px solid var(--brand); outline-offset: 2px; }
.saas .plan-name { font-weight: 700; font-size: 18px; display: flex; justify-content: space-between; align-items: center; }
.saas .pick { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line); flex: none; }
.saas .plan input:checked + .plan-body .pick { border: 6px solid var(--brand); }
.saas .price { font-size: 32px; font-weight: 800; letter-spacing: -.02em; margin: 10px 0 0; }
.saas .price small { font-size: 15px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
.saas .alt { font-size: 13px; color: var(--muted); min-height: 18px; }
.saas .p-year { display: none; }
.saas form:has(input[name=interval][value=year]:checked) .p-year { display: block; }
.saas form:has(input[name=interval][value=year]:checked) .p-month { display: none; }
.saas .trial { display: inline-block; margin-top: 10px; font-size: 13px; font-weight: 600; color: var(--brand); }
.saas .desc { color: var(--muted); font-size: 14px; margin: 10px 0 0; }
.saas ul.limits { list-style: none; padding: 0; margin: 14px 0 0; font-size: 14px; }
.saas ul.limits li { padding: 4px 0; display: flex; gap: 8px; }
.saas ul.limits li::before { content: "✓"; color: var(--brand); font-weight: 700; }
.saas .areas { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; }
.saas .areas span { font-size: 12px; background: #f1f5f9; border-radius: 999px; padding: 3px 9px; color: #334155; }
.saas .account { display: grid; grid-template-columns: 1.2fr 1fr; gap: 22px; align-items: start; }
.saas .account .card h2 { margin-top: 0; }
.saas .side { color: var(--muted); font-size: 14px; }
.saas .side h3 { color: var(--text); font-size: 16px; margin: 0 0 8px; }
.saas .side ul { padding-left: 18px; margin: 0; }
.saas .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.saas button[type=submit] { width: 100%; margin-top: 18px; font-size: 16px; padding: 14px 20px; }
.saas .small { font-size: 12px; }
.saas .error { background: #fef2f2; color: #991b1b; border-radius: 10px; padding: 12px 14px; margin: 0 0 16px; }
@media (max-width: 760px) { .saas .account { grid-template-columns: 1fr; } .saas h1 { font-size: 27px; } }
</style>`;

/** "1.000 Kontakte", "E-Mails pro Monat: unbegrenzt" … – funnels/courses only when the plan has that area. */
function limitLines(p: Plan): string[] {
  const order: LimitKey[] = ['contacts', 'users', 'emails', 'sms', 'ai', 'funnels', 'courses'];
  return order
    .filter((k) => (k === 'funnels' || k === 'courses' ? p.features.includes(k) : true))
    .map((k) => {
      const l = limitOf(p, k);
      return l === null ? `${LIMITS[k]}: unbegrenzt` : `${n(l)} ${LIMITS[k]}`;
    });
}

export const saasSignupModule: Module = {
  name: 'saas-signup',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE saas_signups (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, interval TEXT NOT NULL DEFAULT 'month',
        company TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
        browser_hash TEXT NOT NULL DEFAULT '', session_id TEXT, status TEXT NOT NULL DEFAULT 'pending',
        location_id TEXT, user_id TEXT, new_user INTEGER NOT NULL DEFAULT 1, error TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX saas_signups_session ON saas_signups(session_id);
      CREATE TABLE saas_invites (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, location_id TEXT,
        expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const mailer = (loc: LocationRow, mail: OutMail): Promise<{ status: string }> => (app.services.saasMailer ?? deliverEmail)(loc, mail);

    const brandColor = () => {
      const c = getBranding(app).color;
      return /^#[0-9a-f]{6}$/i.test(c) ? c : undefined;
    };
    const page = (title: string, body: string, opts: { status?: number; head?: string } = {}) => {
      const b = getBranding(app);
      const bar = `<div class="brandbar">${b.logo_url ? `<img src="${escapeHtml(b.logo_url)}" alt="${escapeHtml(b.name)}">` : `<span class="dot">${escapeHtml(b.name.slice(0, 1).toUpperCase())}</span> ${escapeHtml(b.name)}`}</div>`;
      return html(publicPage({ title: `${title} – ${b.name}`, body: `<div class="saas">${bar}${body}</div>`, color: brandColor(), head: SIGNUP_CSS + (opts.head ?? '') }), opts.status ?? 200);
    };
    const message = (title: string, text: string, opts: { status?: number; head?: string; action?: [string, string] } = {}) =>
      page(title, `<div class="card" style="max-width:620px"><h1 style="font-size:26px">${escapeHtml(title)}</h1><p class="lead" style="font-size:16px">${escapeHtml(text)}</p>${opts.action ? `<p><a class="btn" href="${escapeHtml(opts.action[0])}">${escapeHtml(opts.action[1])}</a></p>` : ''}</div>`, opts);

    const signupPlans = (extraId?: string) =>
      db
        .all<{ id: string }>('SELECT id FROM saas_plans WHERE active = 1 AND (public = 1 OR id = ?) ORDER BY sort, price_month_cents, name', extraId ?? '')
        .map((r) => planById(app, r.id)!)
        .filter((p) => p && !isCloudPlanId(p.id));

    // --- invites ---------------------------------------------------------------------
    function createInvite(userId: string, locationId: string | null): string {
      const t = token(32);
      db.insert('saas_invites', { token_hash: sha256(t), user_id: userId, location_id: locationId, expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), created_at: now() });
      return `${app.baseUrl()}/invite/${t}`;
    }

    async function sendWelcome(r: { loc: { id: string; name: string }; user: any; isNew: boolean; plan: Plan }) {
      const s = saasSettings(app);
      const b = getBranding(app);
      const sender = (s.mail_location_id && app.location(s.mail_location_id)) || app.location(r.loc.id);
      if (!sender) return;
      const link = r.isNew ? createInvite(r.user.id, r.loc.id) : `${app.baseUrl()}/app`;
      const text = r.isNew
        ? `Hallo ${r.user.name || ''},\n\ndein Konto „${r.loc.name}“ bei ${b.name} ist bereit (Tarif „${r.plan.name}“).\n\nLege hier dein Passwort fest – der Link ist ${INVITE_DAYS} Tage gültig:\n${link}\n\nDanach meldest du dich unter ${app.baseUrl()}/app mit ${r.user.email} an.\n${b.support_email ? `\nFragen? ${b.support_email}\n` : ''}\nViele Grüße\n${b.name}`
        : `Hallo ${r.user.name || ''},\n\ndein neues Konto „${r.loc.name}“ bei ${b.name} ist bereit (Tarif „${r.plan.name}“). Du findest es nach dem Login unter ${link}.\n\nViele Grüße\n${b.name}`;
      // The agency's own wording, if set (modules/system-mails.ts).
      const builtIn = { subject: r.isNew ? `Willkommen bei ${b.name} – lege dein Passwort fest` : `Dein neues Konto bei ${b.name}`, text };
      const m = app.services.systemMail?.(r.isNew ? 'saas_welcome' : 'saas_new_account', builtIn, { brand: b, link, user: r.user, location: r.loc, plan: r.plan, days: INVITE_DAYS, app_url: `${app.baseUrl()}/app` }) ?? builtIn;
      const htmlBody = `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${escapeHtml(m.text)
        .replace(/\n/g, '<br>')
        .replace(escapeHtml(link), `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`)}</body></html>`;
      try {
        await mailer(sender, { to: r.user.email, subject: m.subject, text: m.text, html: htmlBody });
      } catch (e) {
        logSaasEvent(app, r.loc.id, 'mail_failed', `Einladung an ${r.user.email}: ${(e as Error).message}`);
      }
    }

    // --- provisioning --------------------------------------------------------------------
    /** New sub-account (from the plan's snapshot), login and subscription row for a confirmed signup. */
    function provision(signup: any, stripe: { sub?: any; subId?: string; customer?: string } | null) {
      const plan = planById(app, signup.plan_id);
      if (!plan) throw new Error('Tarif nicht gefunden');
      const s = saasSettings(app);
      const loc = createLocation(db, signup.company, 'Europe/Berlin', { email: signup.email, phone: signup.phone });
      const snapId = plan.snapshot_id || s.default_snapshot_id;
      const snap = snapId ? db.get('SELECT * FROM snapshots WHERE id = ?', snapId) : undefined;
      if (snap) {
        try {
          const data = validateSnapshot(JSON.parse(snap.data));
          // The snapshot brings its own pipelines; drop the empty default one.
          if (data.pipelines.length) db.run('DELETE FROM pipelines WHERE location_id = ?', loc.id);
          applySnapshot(app, loc.id, data, { activateWorkflows: s.activate_workflows });
        } catch (e) {
          logSaasEvent(app, loc.id, 'snapshot_failed', (e as Error).message);
        }
      }
      let user = db.get('SELECT * FROM users WHERE email = ?', signup.email);
      let isNew = false;
      if (user) {
        const locs: string[] = JSON.parse(user.locations || '[]');
        if (user.role !== 'admin' && !locs.includes(loc.id)) db.run('UPDATE users SET locations = ? WHERE id = ?', JSON.stringify([...locs, loc.id]), user.id);
      } else {
        user = { id: id(), email: signup.email, name: signup.name || signup.company, role: 'member', locations: [loc.id], created_at: now() };
        // Unknown random password: the customer sets their own through the invite.
        // No usable password at all ('!…' never verifies) until the invite is accepted.
        db.insert('users', { ...user, password_hash: `!unset-${token(12)}` });
        isNew = true;
      }
      const fields = stripe?.sub
        ? fromStripeSub(app, stripe.sub)
        : stripe
          ? { billing: 'stripe' as const, status: plan.trial_days ? ('trialing' as const) : ('active' as const), stripe_subscription: stripe.subId ?? '', stripe_customer: stripe.customer ?? '' }
          : { billing: 'manual' as const, status: 'active' as const };
      upsertSubscription(app, { interval: signup.interval === 'year' ? 'year' : 'month', ...fields, location_id: loc.id, plan_id: plan.id, email: signup.email });
      db.run(`UPDATE saas_signups SET status = 'done', location_id = ?, user_id = ?, new_user = ?, completed_at = ?, error = '' WHERE id = ?`, loc.id, user.id, isNew ? 1 : 0, now(), signup.id);
      logSaasEvent(app, loc.id, 'signup', `${signup.company} · ${plan.name} (${signup.interval === 'year' ? 'jährlich' : 'monatlich'}${stripe ? '' : ', ohne Stripe'})`);
      return { loc, user, isNew, plan };
    }

    /** Stripe confirmed a signup's Checkout (webhook or return page). Safe to call twice. */
    async function completeSignup(session: any) {
      const signup = db.get('SELECT * FROM saas_signups WHERE id = ?', String(session?.metadata?.saas_signup_id ?? ''));
      if (!signup) return { handled: 'unknown_signup' };
      if (signup.status === 'done') return { handled: 'duplicate', locationId: signup.location_id };
      if (session.status && session.status !== 'complete') return { handled: 'not_complete' };
      if (!db.run(`UPDATE saas_signups SET status = 'provisioning', session_id = COALESCE(session_id, ?) WHERE id = ? AND status IN ('pending', 'failed')`, session.id ?? null, signup.id).changes) return { handled: 'in_progress' };
      try {
        const subObj = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
        const subId = String(subObj?.id ?? session.subscription ?? '');
        const sub = subObj ?? (subId ? await fetchSubscription(app, subId) : null);
        const customer = String(typeof session.customer === 'object' ? (session.customer?.id ?? '') : (session.customer ?? ''));
        const r = provision(signup, { sub, subId, customer });
        await sendWelcome(r);
        return { handled: 'account_created', locationId: r.loc.id, userId: r.user.id };
      } catch (e) {
        db.run(`UPDATE saas_signups SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 300), signup.id);
        throw e;
      }
    }
    app.services.saasCompleteSignup = completeSignup;

    // --- the signup page --------------------------------------------------------------------
    function signupPage(ctx: Ctx, opts: { error?: string; values?: Record<string, string>; status?: number } = {}) {
      const s = saasSettings(app);
      const b = getBranding(app);
      const want = String(opts.values?.plan ?? ctx.query.get('plan') ?? '');
      const plans = signupPlans(want);
      if (!s.signup_enabled || !plans.length) return message('Anmeldung geschlossen', 'Neue Konten können gerade nicht online angelegt werden. Bitte melde dich direkt bei uns.', { status: 404, action: b.support_email ? [`mailto:${b.support_email}`, 'Kontakt aufnehmen'] : undefined });
      const v = opts.values ?? {};
      const chosen = plans.find((p) => p.id === want) ?? plans[0];
      const anyYear = plans.some((p) => p.price_year_cents > 0 && p.price_month_cents > 0);
      const maxSave = Math.max(0, ...plans.filter((p) => p.price_month_cents && p.price_year_cents).map((p) => Math.round((1 - p.price_year_cents / (p.price_month_cents * 12)) * 100)));
      const interval = v.interval === 'year' ? 'year' : 'month';
      const cards = plans
        .map((p) => {
          const ints = intervalsOf(p);
          const free = isFree(p);
          const m = p.price_month_cents ? `${euro(p.price_month_cents, p.currency)}<small> / Monat</small>` : free ? 'Kostenlos' : '';
          const y = p.price_year_cents ? `${euro(p.price_year_cents, p.currency)}<small> / Jahr</small>` : free ? 'Kostenlos' : '';
          const monthBlock = m ? `<div class="price">${m}</div><div class="alt">${p.price_year_cents ? `oder ${euro(p.price_year_cents, p.currency)} pro Jahr` : ''}</div>` : `<div class="price">${y}</div><div class="alt">nur jährlich</div>`;
          const yearBlock = y ? `<div class="price">${y}</div><div class="alt">${p.price_month_cents ? `entspricht ${euro(Math.round(p.price_year_cents / 12), p.currency)} pro Monat` : ''}</div>` : `<div class="price">${m}</div><div class="alt">nur monatlich</div>`;
          const areas = (Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]).filter((k) => p.features.includes(k) && k !== 'settings').map((k) => `<span>${escapeHtml(PERMISSIONS[k])}</span>`);
          return `<label class="plan"><input type="radio" name="plan" value="${escapeHtml(p.id)}" ${p.id === chosen.id ? 'checked' : ''} data-intervals="${ints.join(',')}">
  <div class="plan-body">
    <div class="plan-name">${escapeHtml(p.name)} <span class="pick"></span></div>
    <div class="p-month">${monthBlock}</div><div class="p-year">${yearBlock}</div>
    ${p.trial_days && !free ? `<div class="trial">${p.trial_days} Tage kostenlos testen</div>` : ''}
    ${p.description ? `<p class="desc">${escapeHtml(p.description)}</p>` : ''}
    <ul class="limits">${limitLines(p).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    ${areas.length ? `<div class="areas">${areas.join('')}</div>` : ''}
  </div></label>`;
        })
        .join('');
      const field = (name: string, label: string, type = 'text', extra = '') =>
        `<label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(v[name] ?? '')}" ${extra}>`;
      const body = `<h1>${escapeHtml(s.signup_title || `${b.name} jetzt starten`)}</h1>
<p class="lead">${escapeHtml(s.signup_text || 'Wähle deinen Tarif, lege dein Konto an und leg direkt los – in zwei Minuten.')}</p>
${opts.error ? `<div class="error" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<form method="post" action="/signup">
  ${anyYear ? `<div class="interval" role="radiogroup" aria-label="Abrechnung"><label><input type="radio" name="interval" value="month" ${interval === 'month' ? 'checked' : ''}> Monatlich</label><label><input type="radio" name="interval" value="year" ${interval === 'year' ? 'checked' : ''}> Jährlich ${maxSave > 0 ? `<span class="save">bis ${maxSave} % sparen</span>` : ''}</label></div>` : `<input type="hidden" name="interval" value="${plans.every((p) => !p.price_month_cents && p.price_year_cents) ? 'year' : 'month'}">`}
  <div class="plans">${cards}</div>
  <div class="account">
    <div class="card">
      <h2>Dein Konto</h2>
      ${field('company', 'Firmenname', 'text', 'required maxlength="120" autocomplete="organization"')}
      <div class="row"><div>${field('name', 'Dein Name', 'text', 'maxlength="120" autocomplete="name"')}</div><div>${field('phone', 'Telefon (optional)', 'tel', 'maxlength="40" autocomplete="tel"')}</div></div>
      ${field('email', 'E-Mail (dein Login)', 'email', 'required maxlength="200" autocomplete="email"')}
      <div class="hp" aria-hidden="true"><label for="f-website">Website</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>
      ${s.terms_url ? `<label class="check"><input type="checkbox" name="terms" value="1" required ${v.terms ? 'checked' : ''}> <span>Ich akzeptiere die <a href="${escapeHtml(s.terms_url)}" target="_blank" rel="noopener">AGB</a>.</span></label>` : ''}
      <button type="submit">Konto anlegen</button>
      <p class="muted small" style="text-align:center;margin-bottom:0">Bezahlung sicher über Stripe (Karte, SEPA, Apple Pay …). Jederzeit kündbar.</p>
    </div>
    <div class="side">
      <h3>So geht's weiter</h3>
      <ul><li>Tarif wählen und Konto anlegen</li><li>Bei Stripe bezahlen – ${plans.some((p) => p.trial_days) ? 'in der Testphase wird noch nichts abgebucht' : 'Karte oder SEPA'}</li><li>Passwort festlegen – du landest direkt in deinem Konto</li></ul>
      <p style="margin-top:14px">Schon Kunde? <a href="/app">Zum Login</a>${b.support_email ? ` · Fragen: <a href="mailto:${escapeHtml(b.support_email)}">${escapeHtml(b.support_email)}</a>` : ''}</p>
    </div>
  </div>
</form>`;
      return page(s.signup_title || 'Konto anlegen', body, { status: opts.status });
    }

    // A link to a cloud plan (/signup?plan=cloud-team) leads to the cloud's own pricing page (in waitlist mode: the waitlist).
    router.get('/signup', 'public', (ctx) => (isCloudPlanId(ctx.query.get('plan')) && cloudEnabled(app) ? redirect('/cloud', 302) : signupPage(ctx)));

    router.post('/signup', 'public', async (ctx) => {
      const s = saasSettings(app);
      const b = ctx.body ?? {};
      const values: Record<string, string> = {};
      for (const k of ['plan', 'interval', 'company', 'name', 'email', 'phone', 'terms']) values[k] = String(b[k] ?? '').trim().slice(0, 200);
      const fail = (error: string, status = 400) => signupPage(ctx, { error, values, status });
      if (!s.signup_enabled) return signupPage(ctx);
      // Bots fill the hidden field: answer like a success, do nothing.
      if (String(b.website ?? '').trim()) return message('Fast geschafft', 'Bitte prüfe dein E-Mail-Postfach.');
      if (throttled(`signup:${ctx.ip}`, 10)) return fail('Zu viele Versuche – bitte in ein paar Minuten noch einmal.', 429);
      const plan = planById(app, values.plan);
      if (!plan || !plan.active || isCloudPlanId(plan.id)) return fail('Bitte einen Tarif wählen.');
      const interval: Interval = values.interval === 'year' ? 'year' : 'month';
      if (!intervalsOf(plan).includes(interval)) return fail(`„${plan.name}“ gibt es nur ${intervalsOf(plan)[0] === 'year' ? 'jährlich' : 'monatlich'}.`);
      const company = values.company;
      if (!company) return fail('Bitte den Firmennamen angeben.');
      if (company.length > 120 || values.name.length > 120) return fail('Name ist zu lang.');
      const email = normalizeEmail(values.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return fail('Bitte eine gültige E-Mail-Adresse angeben.');
      if (s.terms_url && !values.terms) return fail('Bitte die AGB akzeptieren.');
      if (db.get('SELECT id FROM users WHERE email = ?', email)) return fail('Für diese E-Mail gibt es schon ein Konto. Bitte melde dich an (Zum Login) oder nimm eine andere Adresse.');
      const free = isFree(plan);
      if (free && throttled(`free:${ctx.ip}`, 3)) return fail('Zu viele neue Konten von hier – bitte später noch einmal.', 429);
      if (!free && !stripeKeyOf(app)) return fail('Die Online-Bezahlung ist gerade nicht eingerichtet – bitte melde dich direkt bei uns.', 503);

      const browser = token(24);
      const signup = { id: id(), plan_id: plan.id, interval, company, name: values.name, email, phone: values.phone.slice(0, 40), browser_hash: sha256(browser), status: 'pending', ip: ctx.ip, created_at: now() };
      db.insert('saas_signups', signup);
      ctx.setCookie(SIGNUP_COOKIE, browser, { maxAge: 24 * 3600 });

      if (free) {
        const r = provision(signup, null);
        await sendWelcome(r);
        return redirect(createInvite(r.user.id, r.loc.id).replace(app.baseUrl(), ''), 303);
      }
      try {
        const price = await app.services.saasPriceId(plan, interval);
        const base = app.baseUrl();
        const meta = { saas_signup_id: signup.id, plan_id: plan.id, interval };
        const session = await saasStripe(app, 'POST', '/v1/checkout/sessions', {
          mode: 'subscription',
          line_items: [{ price, quantity: 1 }],
          customer_email: email,
          client_reference_id: signup.id,
          success_url: `${base}/signup/done?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${base}/signup?plan=${encodeURIComponent(plan.id)}`,
          metadata: meta,
          subscription_data: { metadata: meta, ...(plan.trial_days ? { trial_period_days: plan.trial_days } : {}) },
          allow_promotion_codes: true,
        });
        if (!session?.id || !session?.url) throw new HttpError(502, 'Stripe hat keine Bezahlseite geliefert');
        db.run('UPDATE saas_signups SET session_id = ? WHERE id = ?', session.id, signup.id);
        return redirect(session.url, 303);
      } catch (e) {
        db.run(`UPDATE saas_signups SET status = 'failed', error = ? WHERE id = ?`, (e as Error).message.slice(0, 300), signup.id);
        return fail(`Bezahlung gerade nicht möglich: ${(e as Error).message}`, 502);
      }
    });

    /** Back from Stripe: confirm right away, then straight to "set your password" in the same browser. */
    router.get('/signup/done', 'public', async (ctx) => {
      const sid = String(ctx.query.get('session_id') ?? '');
      let signup = /^cs_[A-Za-z0-9_]+$/.test(sid) ? db.get('SELECT * FROM saas_signups WHERE session_id = ?', sid) : undefined;
      if (!signup) return message('Danke!', 'Wir richten dein Konto ein. Du bekommst gleich eine E-Mail mit deinem Zugang.');
      if (signup.status === 'pending' || signup.status === 'failed') {
        try {
          const session = await saasStripe(app, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sid)}`, { expand: ['subscription'] });
          if (session?.metadata?.saas_signup_id === signup.id && session.status === 'complete') await completeSignup(session);
        } catch (e) {
          console.error('[saas] Rückkehr prüfen', (e as Error).message);
        }
        signup = db.get('SELECT * FROM saas_signups WHERE id = ?', signup.id)!;
      }
      if (signup.status === 'done') {
        const mine = !!ctx.cookies[SIGNUP_COOKIE] && sha256(ctx.cookies[SIGNUP_COOKIE]) === signup.browser_hash;
        const used = db.get('SELECT 1 AS x FROM saas_invites WHERE user_id = ? AND used_at IS NOT NULL', signup.user_id);
        if (mine && signup.new_user && !used && db.get('SELECT id FROM users WHERE id = ?', signup.user_id)) {
          ctx.setCookie(SIGNUP_COOKIE, '', { maxAge: 0 });
          return redirect(createInvite(signup.user_id, signup.location_id).replace(app.baseUrl(), ''), 303);
        }
        return message('Dein Konto ist bereit', `Wir haben dir eine E-Mail an ${signup.email} geschickt. Darin legst du dein Passwort fest und meldest dich an.`, { action: ['/app', 'Zum Login'] });
      }
      return message('Einen Moment …', 'Wir bestätigen gerade deine Zahlung und richten dein Konto ein. Diese Seite lädt sich von selbst neu.', { head: '<meta http-equiv="refresh" content="3">' });
    });

    // --- invite: set password, sign in ------------------------------------------------------
    const inviteOf = (t: string) => {
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(t)) return undefined;
      const inv = db.get('SELECT * FROM saas_invites WHERE token_hash = ?', sha256(t));
      if (!inv || inv.used_at || inv.expires_at < now()) return undefined;
      const user = db.get('SELECT * FROM users WHERE id = ?', inv.user_id);
      return user ? { inv, user } : undefined;
    };
    const invitePage = (t: string, user: any, error = '', status = 200) =>
      page(
        'Passwort festlegen',
        `<div class="card" style="max-width:480px"><h1 style="font-size:26px">Willkommen${user.name ? `, ${escapeHtml(user.name)}` : ''}!</h1>
<p class="muted">Lege ein Passwort für <strong>${escapeHtml(user.email)}</strong> fest – danach bist du direkt in deinem Konto.</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/invite/${escapeHtml(t)}">
<label for="p1">Passwort (mindestens 8 Zeichen)</label><input id="p1" name="password" type="password" minlength="8" required autocomplete="new-password" autofocus>
<label for="p2">Passwort wiederholen</label><input id="p2" name="password2" type="password" minlength="8" required autocomplete="new-password">
<button type="submit">Passwort speichern und loslegen</button></form></div>`,
        { status },
      );
    const expired = () => message('Link abgelaufen', `Dieser Link ist nicht mehr gültig. Melde dich an (Passwort vergessen? Bitte bei uns melden) – Einladungslinks gelten ${INVITE_DAYS} Tage und nur einmal.`, { status: 410, action: ['/app', 'Zum Login'] });

    router.get('/invite/:token', 'public', (ctx) => {
      const found = inviteOf(ctx.params.token);
      if (!found) return expired();
      return invitePage(ctx.params.token, found.user);
    });
    router.post('/invite/:token', 'public', async (ctx) => {
      const found = inviteOf(ctx.params.token);
      if (!found) return expired();
      if (throttled(`invite:${ctx.ip}`, 30)) return invitePage(ctx.params.token, found.user, 'Zu viele Versuche – bitte kurz warten.', 429);
      const pw = String(ctx.body?.password ?? '');
      if (pw.length < 8) return invitePage(ctx.params.token, found.user, 'Das Passwort braucht mindestens 8 Zeichen.', 400);
      if (pw.length > 200) return invitePage(ctx.params.token, found.user, 'Das Passwort ist zu lang.', 400);
      if (pw !== String(ctx.body?.password2 ?? '')) return invitePage(ctx.params.token, found.user, 'Die beiden Passwörter sind nicht gleich.', 400);
      // Claim the link first: two parallel posts can't both set a password with one single-use link.
      if (!db.run('UPDATE saas_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now(), sha256(ctx.params.token)).changes) return expired();
      db.run('UPDATE saas_invites SET used_at = ? WHERE user_id = ? AND used_at IS NULL', now(), found.user.id);
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPasswordAsync(pw), found.user.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', found.user.id);
      const t = token(32);
      db.insert('sessions', { token_hash: sha256(t), user_id: found.user.id, created_at: now(), expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
      app.services.onSessionStart?.(sha256(t), ctx, found.user.id);
      ctx.setCookie(SESSION_COOKIE, t, { maxAge: SESSION_DAYS * 86400 });
      logSaasEvent(app, found.inv.location_id, 'invite_accepted', found.user.email);
      return redirect('/app', 303);
    });

    // --- agency: recent signups, fresh invite link ---------------------------------------------
    router.get('/api/saas/signups', 'admin', () =>
      db.all(`SELECT s.id, s.plan_id, p.name AS plan_name, s.interval, s.company, s.name, s.email, s.status, s.location_id, s.error, s.created_at, s.completed_at
              FROM saas_signups s LEFT JOIN saas_plans p ON p.id = s.plan_id ORDER BY s.created_at DESC LIMIT 100`),
    );
    router.post('/api/saas/signups/:id/invite', 'admin', async (ctx) => {
      const s = db.get('SELECT * FROM saas_signups WHERE id = ?', ctx.params.id);
      if (!s) throw notFound();
      if (s.status !== 'done' || !s.user_id) throw bad('Das Konto ist noch nicht angelegt');
      const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
      if (!user) throw bad('Der Login wurde gelöscht');
      if (user.role === 'admin') throw bad('Für Agentur-Admins gibt es keine Einladungslinks');
      const url = createInvite(user.id, s.location_id);
      const loc = app.location(s.location_id);
      const sender = (saasSettings(app).mail_location_id && app.location(saasSettings(app).mail_location_id)) || loc;
      let mail = 'skipped';
      if (sender && ctx.body?.send !== false) {
        try {
          mail = (await mailer(sender, { to: user.email, subject: `Dein Zugang zu ${getBranding(app).name}`, text: `Hallo ${user.name || ''},\n\nhier ist dein Link zum Passwort-Festlegen (${INVITE_DAYS} Tage gültig):\n${url}`, html: `<p>Hallo ${escapeHtml(user.name || '')},</p><p>hier ist dein Link zum Passwort-Festlegen (${INVITE_DAYS} Tage gültig):<br><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>` })).status;
        } catch (e) {
          mail = `Fehler: ${(e as Error).message}`;
        }
      }
      return { url, mail };
    });
  },
};
