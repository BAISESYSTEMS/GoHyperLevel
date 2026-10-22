import type { App, Module } from '../core/app.js';
import { normalizeDomain } from '../core/domains.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { sealSettings } from '../core/secrets.js';
import { isValidTz } from '../core/time.js';
import { id, normalizeEmail, now, sha256, slugify, token, verifyPasswordAsync } from '../core/util.js';
import { cleanPermissions } from '../core/permissions.js';
import { ALL_AREAS, PLAN_INFO, entitlements, type PlanKey } from '../services/cloud.js';
import { exportTenant, eraseLocations } from '../services/cloud-export.js';
import { forgetUser } from '../services/user-erase.js';
import { renderMarkdown } from '../services/markdown.js';
import { buildWikiPdf } from '../services/wiki-pdf.js';
import type { PageRow } from '../services/wiki-store.js';
import { createLocation } from './core.js';
import {
  appLink,
  cloudBrand,
  cloudEnabled,
  cloudSettings,
  grantOwnerHr,
  legalCurrent,
  legalText,
  legalVersion,
  logCloudEvent,
  meters,
  pendingLegal,
  recordAcceptance,
  requireTenant,
  sendCloudMail,
  syncChildren,
  tenantLocationIds,
  tenantPlanKey,
  tenantSub,
  tenantSummary,
  type Tenant,
} from './cloud.js';
import { getBranding } from './agency.js';
import { fromStripeSub, saasStripe, stockCount, stripeKeyOf, upsertSubscription } from './saas.js';
import { ACCEPTED_DOCS } from '../services/cloud-legal.js';

/**
 * The customer's account area (Einstellungen → Cloud-Konto): the team, client sub-accounts and white-label of an Agentur
 * customer, the data export, "delete my account" (scheduled), the support-access consent, the AVV download, the onboarding
 * checklist. Everything is scoped to the signed-in customer's tenant – the routes never take a tenant id from the request.
 */

// --- white-label (Agentur) ----------------------------------------------------------------------------------------------

const BRAND_TEXT = ['name', 'logo_url', 'logo_dark_url', 'mark_url', 'mark_dark_url', 'favicon_url', 'show_name', 'login_title', 'login_text', 'support_email'] as const;

function cleanBrand(b: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of BRAND_TEXT) {
    if (b[k] === undefined) continue;
    const v = str(b[k], k, { max: 1000 });
    if (k.endsWith('_url') && v && !/^(https?:\/\/|\/uploads\/)/i.test(v)) throw bad('Bild-Adresse muss mit https:// beginnen');
    if (k === 'support_email' && v && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v)) throw bad('Support-E-Mail ist ungültig');
    if (v) out[k] = v;
  }
  if (b.color !== undefined && b.color !== '') {
    if (!/^#[0-9a-f]{6}$/i.test(String(b.color))) throw bad('Farbe als #rrggbb');
    out.color = String(b.color);
  }
  return out;
}

function writeBranding(app: App, locationId: string, next: Record<string, any>) {
  const loc = app.location(locationId);
  if (!loc) return;
  app.db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, branding: next }).value), locationId);
}

/** White-label of every sub-account of the tenant; each keeps its own login domain. */
export function applyBranding(app: App, t: Tenant, brand: Record<string, string>) {
  for (const lid of tenantLocationIds(app, t.id)) {
    const cur = app.location(lid)?.settings?.branding ?? {};
    writeBranding(app, lid, { ...brand, ...(cur.app_domain ? { app_domain: cur.app_domain } : {}) });
  }
}
/** Back to the operator's look (a plan without white-label). */
export const resetWhiteLabel = (app: App, t: Tenant) => applyBranding(app, t, {});

// --- team ---------------------------------------------------------------------------------------------------------------------

const INVITE_DAYS = 7;
/** What a login for one client account of an Agentur gets by default (the owner can widen it). */
const CLIENT_AREAS = ['dashboard', 'conversations', 'calendars', 'contacts', 'funnels', 'forms'] as const;

export function createInvite(app: App, userId: string, locationId: string): string {
  const t = token(32);
  app.db.insert('saas_invites', { token_hash: sha256(t), user_id: userId, location_id: locationId, expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), created_at: now() });
  return `${app.baseUrl()}/invite/${t}`;
}


export const cloudAccountModule: Module = {
  name: 'cloud-account',
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;

    const memberRows = (t: Tenant) =>
      db
        .all<{ id: string; email: string; name: string; locations: string; permissions: string | null; created_at: string; role: string; all_locations: number; password_set: number }>(
          `SELECT u.id, u.email, u.name, u.locations, u.permissions, u.created_at, u.password_set, m.role, m.all_locations FROM cloud_members m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? ORDER BY m.role DESC, u.created_at`,
          t.id,
        )
        .map((r) => ({ id: r.id, email: r.email, name: r.name, role: r.role, all_locations: !!r.all_locations, locations: JSON.parse(r.locations || '[]') as string[], hr: !r.permissions || (JSON.parse(r.permissions) as string[]).includes('personal'), invited: !r.password_set, created_at: r.created_at }));

    const plan = (t: Tenant): PlanKey => tenantPlanKey(app, t);
    const readOnly = (t: Tenant) => {
      const st = tenantSub(app, t)?.status;
      if (st === 'paused' || st === 'canceled') throw new HttpError(403, 'Das Konto ist schreibgeschützt – bitte zuerst die Zahlung erledigen oder ein Abo abschließen.');
    };

    // --- team ---------------------------------------------------------------------------------------------------------------
    router.get('/api/cloud/team', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      const ent = entitlements(plan(t), cloudSettings(app));
      return { members: memberRows(t), limit: ent.users, locations: tenantLocationIds(app, t.id).map((lid) => ({ id: lid, name: app.location(lid)?.name ?? '', primary: lid === t.location_id })) };
    });

    router.post('/api/cloud/team', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      readOnly(t);
      const ent = entitlements(plan(t), cloudSettings(app));
      const b = ctx.body ?? {};
      const email = normalizeEmail(b.email);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
      if (ent.users !== null && memberRows(t).length >= ent.users) throw new HttpError(403, `${PLAN_INFO[plan(t)].name} ist für ${ent.users} Nutzer. Für mehr Nutzer wechsle auf Cloud Team & Company – ohne Gebühr pro Nutzer.`);
      if (db.get('SELECT id FROM users WHERE email = ?', email)) throw bad('Diese E-Mail-Adresse hat schon ein Konto');
      const all = tenantLocationIds(app, t.id);
      let locs = all;
      let allLocations = 1;
      if (Array.isArray(b.locations) && b.locations.length) {
        locs = b.locations.map(String).filter((l: string) => all.includes(l));
        if (!locs.length) throw bad('Bitte mindestens einen Sub-Account auswählen');
        allLocations = locs.length === all.length ? 1 : 0;
      }
      // Everything except HR unless the owner says so; a login for a single client account gets the usual client areas.
      const perms = Array.isArray(b.permissions) ? cleanPermissions(b.permissions) : allLocations ? ALL_AREAS.filter((a) => a !== 'personal' || b.hr) : CLIENT_AREAS;
      const user = { id: id(), email, name: str(b.name, 'Name', { max: 120 }) || email, password_hash: `!unset-${token(12)}`, role: 'member', locations: locs, permissions: perms, created_at: now(), password_set: 0 };
      db.tx(() => {
        db.insert('users', user);
        db.insert('cloud_members', { user_id: user.id, tenant_id: t.id, role: 'member', all_locations: allLocations, created_at: now() });
      });
      const link = createInvite(app, user.id, locs[0]);
      const sent = await sendCloudMail(app, 'invite', email, { name: user.name, inviter: ctx.user!.name || ctx.user!.email, company: t.name, link });
      logCloudEvent(app, t.id, 'member_invited', email);
      app.services.audit?.({ ctx, action: 'cloud.team.invite', summary: email, locationId: t.location_id });
      return { ...memberRows(t).find((m) => m.id === user.id), mail: sent, link };
    });

    router.post('/api/cloud/team/:id/invite', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const m = memberRows(t).find((x) => x.id === ctx.params.id);
      if (!m) throw notFound('Nutzer nicht gefunden');
      if (!m.invited) throw bad('Diese Person hat sich schon angemeldet');
      const link = createInvite(app, m.id, m.locations[0] ?? t.location_id);
      const mail = await sendCloudMail(app, 'invite', m.email, { name: m.name, inviter: ctx.user!.name || ctx.user!.email, company: t.name, link });
      return { mail, link };
    });

    router.patch('/api/cloud/team/:id', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      const m = memberRows(t).find((x) => x.id === ctx.params.id);
      if (!m) throw notFound('Nutzer nicht gefunden');
      if (m.role === 'owner') throw bad('Die Inhaberin bzw. der Inhaber behält immer Zugriff');
      const all = tenantLocationIds(app, t.id);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = {};
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { max: 120 }) || m.email;
      if (Array.isArray(b.locations)) {
        const locs = b.locations.map(String).filter((l: string) => all.includes(l));
        if (!locs.length) throw bad('Bitte mindestens einen Sub-Account auswählen');
        patch.locations = locs;
        db.run('UPDATE cloud_members SET all_locations = ? WHERE user_id = ?', locs.length === all.length ? 1 : 0, m.id);
      }
      if (Array.isArray(b.permissions)) patch.permissions = cleanPermissions(b.permissions);
      else if (b.hr !== undefined) {
        const cur = db.get<{ permissions: string | null }>('SELECT permissions FROM users WHERE id = ?', m.id)?.permissions;
        const list = (cur ? (JSON.parse(cur) as string[]) : ALL_AREAS.filter((a) => a !== 'personal')).filter((a) => a !== 'personal');
        patch.permissions = b.hr ? [...list, 'personal'] : list;
      }
      if (Object.keys(patch).length) db.update('users', m.id, patch);
      return memberRows(t).find((x) => x.id === m.id);
    });

    router.delete('/api/cloud/team/:id', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      const m = memberRows(t).find((x) => x.id === ctx.params.id);
      if (!m) throw notFound('Nutzer nicht gefunden');
      if (m.role === 'owner') throw bad('Die Inhaberin bzw. der Inhaber kann nicht entfernt werden');
      db.tx(() => {
        db.run('DELETE FROM users WHERE id = ?', m.id);
        forgetUser(app, m.id);
      });
      logCloudEvent(app, t.id, 'member_removed', '');
      app.services.audit?.({ ctx, action: 'cloud.team.remove', summary: m.email, locationId: t.location_id });
      return { ok: true };
    });

    // --- client sub-accounts and white-label (Agentur) ------------------------------------------------------------------------
    /** White-label, custom domains and client sub-accounts are the Agentur plan's own entitlements (every plan has every area). */
    const needAgency = (t: Tenant, what: 'client_accounts' | 'white_label' | 'custom_domain' = 'client_accounts') => {
      if (!entitlements(plan(t), cloudSettings(app))[what]) throw new HttpError(403, 'White-Label, eigene Domains und Kunden-Accounts gibt es im Tarif Cloud Agentur.');
    };
    const clientRow = (t: Tenant, lid: string) => {
      const l = app.location(lid)!;
      return {
        id: lid,
        name: l.name,
        primary: lid === t.location_id,
        created_at: l.created_at,
        contacts: stockCount(app, lid, 'contacts'),
        users: stockCount(app, lid, 'users'),
        meters: meters(app, lid, 'agency'),
        domain: l.settings?.branding?.app_domain ?? '',
        domain_status: l.settings?.branding?.app_domain ? app.services.domainStatus?.(l.settings.branding.app_domain) : undefined,
      };
    };

    router.get('/api/cloud/clients', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      needAgency(t);
      const s = cloudSettings(app);
      return { items: tenantLocationIds(app, t.id).map((lid) => clientRow(t, lid)), max: s.agency_max_clients || null };
    });

    router.post('/api/cloud/clients', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      needAgency(t);
      readOnly(t);
      const s = cloudSettings(app);
      const ids = tenantLocationIds(app, t.id);
      if (s.agency_max_clients && ids.length - 1 >= s.agency_max_clients) throw new HttpError(403, `Fair Use: bis ${s.agency_max_clients} Kunden-Accounts sind inklusive – melde dich für mehr beim Support.`);
      const b = ctx.body ?? {};
      const name = str(b.name, 'Name', { required: true, max: 120 });
      const tz = str(b.timezone, 'Zeitzone') || 'Europe/Berlin';
      if (!isValidTz(tz)) throw bad('Unbekannte Zeitzone');
      const brand = app.location(t.location_id)?.settings?.branding ?? {};
      const { app_domain: _d, ...look } = brand;
      const loc = db.tx(() => {
        const l = createLocation(db, name, tz, { email: str(b.email, 'E-Mail', { max: 200 }), settings: { email: { provider: 'log' }, sms: { provider: 'log' }, ...(Object.keys(look).length ? { branding: look } : {}) } });
        db.insert('cloud_locations', { location_id: l.id, tenant_id: t.id, role: 'client', created_at: now() });
        if (t.owner_user_id) grantOwnerHr(app, l.id, t.owner_user_id);
        // Everybody who works in all sub-accounts gets the new one.
        for (const m of memberRows(t).filter((x) => x.all_locations)) db.update('users', m.id, { locations: [...m.locations, l.id] });
        return l;
      });
      syncChildren(app, t);
      logCloudEvent(app, t.id, 'client_created', '');
      app.services.audit?.({ ctx, action: 'cloud.client.create', summary: name, locationId: loc.id });
      return clientRow(t, loc.id);
    });

    router.patch('/api/cloud/clients/:id', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      needAgency(t);
      if (!tenantLocationIds(app, t.id).includes(ctx.params.id)) throw notFound('Kunden-Account nicht gefunden');
      const name = str(ctx.body?.name, 'Name', { required: true, max: 120 });
      db.update('locations', ctx.params.id, { name });
      return clientRow(t, ctx.params.id);
    });

    // DELETE with a body is awkward for browsers: the app uses POST …/delete, both do the same.
    const removeClient = async (ctx: Ctx) => {
      const t = requireTenant(app, ctx);
      needAgency(t);
      if (ctx.params.id === t.location_id) throw bad('Das Haupt-Konto lässt sich nur mit dem ganzen Cloud-Konto löschen');
      if (!tenantLocationIds(app, t.id).includes(ctx.params.id)) throw notFound('Kunden-Account nicht gefunden');
      const loc = app.location(ctx.params.id)!;
      if (str(ctx.body?.confirm, 'Bestätigung') !== loc.name) throw bad('Zur Bestätigung den Namen des Kunden-Accounts eintippen');
      const out = eraseLocations(app, [ctx.params.id]);
      for (const m of memberRows(t)) {
        const rest = m.locations.filter((l) => l !== ctx.params.id);
        if (rest.length !== m.locations.length) {
          if (!rest.length && m.role !== 'owner') {
            db.run('DELETE FROM users WHERE id = ?', m.id);
            forgetUser(app, m.id);
          }
          else db.update('users', m.id, { locations: rest });
        }
      }
      logCloudEvent(app, t.id, 'client_deleted', `${out.rows} Zeilen`);
      app.services.audit?.({ ctx, action: 'cloud.client.delete', summary: loc.name, locationId: t.location_id });
      return { ok: true, ...out };
    };
    router.delete('/api/cloud/clients/:id', 'user', removeClient);
    router.post('/api/cloud/clients/:id/delete', 'user', removeClient);

    router.get('/api/cloud/branding', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      needAgency(t, 'white_label');
      const { app_domain: _d, ...mine } = app.location(t.location_id)?.settings?.branding ?? {};
      return { ...mine, defaults: { name: getBranding(app).name } };
    });
    router.put('/api/cloud/branding', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      needAgency(t, 'white_label');
      readOnly(t);
      applyBranding(app, t, cleanBrand(ctx.body ?? {}));
      logCloudEvent(app, t.id, 'branding_changed', '');
      app.services.audit?.({ ctx, action: 'cloud.branding', summary: 'White-Label geändert', locationId: t.location_id });
      const { app_domain: _d, ...mine } = app.location(t.location_id)?.settings?.branding ?? {};
      return mine;
    });

    /** A login domain per sub-account (white-label); the tenant's own sub-domain is set at signup. */
    router.put('/api/cloud/domain', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      needAgency(t, 'custom_domain');
      readOnly(t);
      const lid = String(ctx.body?.location_id ?? t.location_id);
      if (!tenantLocationIds(app, t.id).includes(lid)) throw notFound('Sub-Account nicht gefunden');
      const domain = normalizeDomain(ctx.body?.domain ?? '');
      const s = cloudSettings(app);
      if (domain) {
        const taken =
          domain === getBranding(app).app_domain ||
          (s.cloud_domain && (domain === s.cloud_domain || domain.endsWith(`.${s.cloud_domain}`))) ||
          db.get('SELECT id FROM funnels WHERE domain = ?', domain) ||
          db.get(`SELECT id FROM locations WHERE id != ? AND json_extract(settings, '$.branding.app_domain') = ?`, lid, domain);
        if (taken) throw bad('Diese Domain ist schon vergeben');
      }
      const loc = app.location(lid)!;
      const cur = { ...(loc.settings?.branding ?? {}) };
      if (domain) cur.app_domain = domain;
      else delete cur.app_domain;
      writeBranding(app, lid, cur);
      logCloudEvent(app, t.id, 'domain_changed', domain);
      return clientRow(t, lid);
    });

    // --- data export ------------------------------------------------------------------------------------------------------------
    router.get('/api/cloud/export', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      const r = exportTenant(app, { id: t.id, name: t.name }, tenantLocationIds(app, t.id));
      logCloudEvent(app, t.id, 'export', `${r.tables} Tabellen, ${r.rows} Zeilen, ${r.files} Dateien`);
      app.services.audit?.({ ctx, action: 'cloud.export', summary: `${r.tables} Tabellen, ${r.files} Dateien`, locationId: t.location_id });
      return { __raw: true, status: 200, headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="export-${slugify(t.slug)}-${new Date().toISOString().slice(0, 10)}.zip"`, 'cache-control': 'no-store' }, body: r.zip };
    });

    // --- delete my account (scheduled) ---------------------------------------------------------------------------------------------
    router.post('/api/cloud/delete', 'user', async (ctx) => {
      const t = requireTenant(app, ctx);
      const b = ctx.body ?? {};
      if (str(b.confirm, 'Bestätigung') !== t.name) throw bad('Zur Bestätigung den Namen deiner Firma genau eintippen');
      const u = db.get('SELECT * FROM users WHERE id = ?', ctx.user!.id)!;
      // A password sign-in has to prove itself again; Google-only owners confirm with the name alone.
      if (u.password_set && !(await verifyPasswordAsync(String(b.password ?? '').slice(0, 1024), u.password_hash))) throw bad('Passwort falsch');
      const s = cloudSettings(app);
      const sub = tenantSub(app, t)!;
      if (sub.status !== 'canceled') {
        if (sub.billing === 'stripe' && sub.stripe_subscription && stripeKeyOf(app)) {
          const ended = await saasStripe(app, 'DELETE', `/v1/subscriptions/${encodeURIComponent(sub.stripe_subscription)}`, { prorate: false });
          upsertSubscription(app, { ...fromStripeSub(app, { ...ended, status: 'canceled' }, sub), location_id: t.location_id, plan_id: sub.plan_id });
        } else {
          upsertSubscription(app, { location_id: t.location_id, plan_id: sub.plan_id, status: 'canceled', canceled_at: now(), cancel_at_period_end: 0 });
        }
      }
      const at = new Date(Date.now() + s.self_delete_days * 864e5).toISOString();
      db.run(`UPDATE cloud_tenants SET deletion_at = ?, deletion_reason = 'self', read_only_since = COALESCE(read_only_since, ?), updated_at = ? WHERE id = ?`, at, now(), now(), t.id);
      logCloudEvent(app, t.id, 'deletion_scheduled', `Löschung auf Wunsch des Kunden am ${at.slice(0, 10)}`);
      app.services.audit?.({ ctx, action: 'cloud.delete.request', summary: `Löschung am ${at.slice(0, 10)}`, locationId: t.location_id });
      void sendCloudMail(app, 'self_delete', t.email, { name: ctx.user!.name, company: t.name, delete_at: new Date(at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }), link: appLink(app, '/app/settings/cloud') });
      syncChildren(app, t);
      const fresh = db.get<Tenant>('SELECT * FROM cloud_tenants WHERE id = ?', t.id)!;
      return tenantSummary(app, fresh);
    });

    router.post('/api/cloud/delete/undo', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      if (t.deletion_reason !== 'self') throw bad('Es ist keine Löschung auf deinen Wunsch geplant');
      db.run(`UPDATE cloud_tenants SET deletion_at = NULL, deletion_reason = '', updated_at = ? WHERE id = ?`, now(), t.id);
      logCloudEvent(app, t.id, 'deletion_undone', '');
      app.services.audit?.({ ctx, action: 'cloud.delete.undo', summary: '', locationId: t.location_id });
      return tenantSummary(app, db.get<Tenant>('SELECT * FROM cloud_tenants WHERE id = ?', t.id)!);
    });

    // --- support access (the operator may open the account) -----------------------------------------------------------------------------
    router.put('/api/cloud/support', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      const hours = Number(ctx.body?.hours ?? 0);
      if (![0, 1, 24, 168, 720].includes(hours)) throw bad('Dauer: 0 (aus), 1, 24, 168 oder 720 Stunden');
      const until = hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null;
      db.run('UPDATE cloud_tenants SET support_until = ?, updated_at = ? WHERE id = ?', until, now(), t.id);
      logCloudEvent(app, t.id, 'support_consent', hours ? `${hours} Stunden` : 'widerrufen');
      app.services.audit?.({ ctx, action: hours ? 'cloud.support.allow' : 'cloud.support.revoke', summary: hours ? `Support-Zugriff für ${hours} Stunden freigegeben` : 'Support-Zugriff widerrufen', locationId: t.location_id });
      return tenantSummary(app, db.get<Tenant>('SELECT * FROM cloud_tenants WHERE id = ?', t.id)!);
    });

    // --- AVV (the version the customer accepted) -----------------------------------------------------------------------------------------
    router.get('/api/cloud/avv', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      const last = db.get<{ version: number }>(`SELECT MAX(version) AS version FROM cloud_acceptances WHERE tenant_id = ? AND doc = 'avv'`, t.id)?.version;
      const row = (last && legalVersion(app, 'avv', last)) || legalCurrent(app, 'avv');
      const text = legalText(app, row, { company: t.name, email: t.email });
      if (String(ctx.query.get('format')) === 'html') return { __raw: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-disposition': 'attachment; filename="avv.html"' }, body: `<!doctype html><meta charset="utf-8"><title>AVV</title><body style="font-family:sans-serif;max-width:760px;margin:30px auto">${renderMarkdown(text)}</body>` };
      const at = now();
      const page: PageRow = { id: 'avv', location_id: t.location_id, space_id: '', parent_id: null, position: 0, title: `AVV – ${cloudBrand(app)} und ${t.name}`, icon: '', body: text, text: '', version: row.version, trashed_at: null, kb_article_id: null, kb_version: null, created_by: null, created_by_name: '', updated_by: null, updated_by_name: '', created_at: at, updated_at: at };
      const pdf = buildWikiPdf(app, [page], { space: cloudBrand(app), baseUrl: app.baseUrl(), author: '' });
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="avv-v${row.version}.pdf"`, 'cache-control': 'no-store' }, body: Buffer.from(pdf) };
    });

    router.get('/api/cloud/legal', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      return { current: ACCEPTED_DOCS.map((doc) => ({ doc, version: legalCurrent(app, doc).version })), pending: pendingLegal(app, t.id), accepted: db.all('SELECT doc, version, at FROM cloud_acceptances WHERE tenant_id = ? ORDER BY at DESC LIMIT 50', t.id) };
    });
    router.post('/api/cloud/legal/accept', 'user', (ctx) => {
      const t = requireTenant(app, ctx);
      const pending = pendingLegal(app, t.id);
      recordAcceptance(app, { tenantId: t.id, userId: ctx.user!.id, ip: ctx.ip, versions: Object.fromEntries(pending.map((p) => [p.doc, p.version])) });
      logCloudEvent(app, t.id, 'legal_accepted', pending.map((p) => `${p.doc} v${p.version}`).join(', '));
      return { pending: pendingLegal(app, t.id) };
    });

    // --- onboarding checklist (computed from what exists, nothing to tick by hand) -----------------------------------------------------------
    router.get('/api/cloud/onboarding', 'user', (ctx) => {
      const t = requireTenant(app, ctx, false);
      const loc = app.location(t.location_id)!;
      const key = plan(t);
      const sub = tenantSub(app, t);
      const brand = loc.settings?.branding ?? {};
      const items: { key: string; label: string; hint: string; to: string; done: boolean }[] = [
        { key: 'company', label: 'Firmendaten ergänzen', hint: 'Adresse und Telefon erscheinen auf Rechnungen und in E-Mails.', to: 'settings/company', done: !!(loc.address || loc.phone) },
        { key: 'email', label: 'E-Mail-Versand einrichten', hint: 'Damit Nachrichten mit deiner Adresse rausgehen.', to: 'settings/messaging', done: !!loc.settings?.email?.provider && loc.settings.email.provider !== 'log' },
        { key: 'contacts', label: 'Erste Kontakte anlegen oder importieren', hint: 'Von Hand, per CSV oder aus einem anderen System (Umzug).', to: 'contacts', done: stockCount(app, t.location_id, 'contacts') > 0 },
      ];
      if (entitlements(key, cloudSettings(app)).users !== 1) items.push({ key: 'team', label: 'Team einladen', hint: 'Unbegrenzt Nutzer – ohne Aufpreis.', to: 'settings/cloud', done: memberRows(t).length > 1 });
      if (key === 'agency') {
        items.push({ key: 'branding', label: 'Eigenes Branding festlegen', hint: 'Logo, Farbe und Name für dich und deine Kunden.', to: 'settings/cloud', done: !!(brand.logo_url || brand.color || brand.name) });
        items.push({ key: 'client', label: 'Ersten Kunden-Account anlegen', hint: 'Jeder Kunde bekommt ein eigenes, getrenntes Konto.', to: 'settings/cloud', done: tenantLocationIds(app, t.id).length > 1 });
      }
      if (sub?.billing === 'manual' && sub.status === 'trialing') items.push({ key: 'payment', label: 'Tarif und Zahlung wählen', hint: 'Damit nach der Testphase alles weiterläuft.', to: 'settings/cloud', done: false });
      return { items, done: items.filter((i) => i.done).length, total: items.length };
    });

  },
};

