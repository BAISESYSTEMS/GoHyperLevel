import type { App, Module } from '../core/app.js';
import { domainAlias } from '../core/domains.js';
import { bad, HttpError, notFound, str, type Auth, type Ctx } from '../core/http.js';
import { id, now, sha256 } from '../core/util.js';
import { CATEGORIES, cleanReport, pauseReason, REPORT_STATUS, reportForm, WINDOW } from '../services/cloud-abuse.js';
import { messagePage } from '../services/cloud-pages.js';
import { sitesDomain, slugOfSitesHost } from '../services/cloud-sites.js';
import { formToken, formTokenOk, pageCtx, servePage } from './cloud-pages.js';
import { cloudEnabled, cloudSettings, cloudSupport, logCloudEvent, sendCloudMail, tenantById, tenantLocationIds, tenantOfLocation, tenantOfUser, type Tenant } from './cloud.js';

/**
 * Abuse handling in cloud mode (docs/cloud.md#abuse-handling):
 *
 * - `/abuse`: the notice-and-action form of the Digital Services Act (Art. 16: URL, substantiated explanation, name and e-mail –
 *   optional for child sexual abuse material –, good-faith statement). Receipt confirmed by e-mail, the operator alerted, the
 *   customer matched from the URL. Linked from the pricing/legal pages' footer and the status page.
 * - Operator actions per customer (Agentur → Cloud → Missbrauch): pause e-mail/SMS sending, take the sites and forms offline,
 *   suspend the account (customer routes answer 403, export stays open). Each one is logged in the customer's history and the
 *   owner gets the statement of reasons (Art. 17).
 * - Auto-pause: a customer's e-mail sending pauses by itself when more than 0.1 % of the last 500 sent mails were reported as spam or
 *   more than 5 % bounced (judged from 100 sends on). The operator resumes it; only mails after that count again.
 *
 * Hooks: wraps `app.services.usageGate` (registered after modules/saas-gate.ts), one guard, one router wrapper for the public site
 * and form routes; `app.services.cloudAbuse` for others.
 */

interface Flags {
  tenant_id: string;
  sending_paused_at: string | null;
  sending_reason: string;
  sending_auto: number;
  sites_offline_at: string | null;
  sites_reason: string;
  suspended_at: string | null;
  suspend_reason: string;
  window_from: string | null;
  updated_at: string;
}
interface Report {
  id: string;
  category: string;
  urls: string;
  explanation: string;
  reporter_name: string;
  reporter_email: string;
  good_faith: number;
  tenant_id: string | null;
  status: string;
  decision: string;
  decided_at: string | null;
  decided_by: string;
  created_at: string;
}
interface Settings {
  abuse_email: string;
  auto_pause: boolean;
}

const ACTIONS: Record<string, { label: string; event: string; mail?: (reason: string) => string[] }> = {
  pause_sending: { label: 'Versand pausiert', event: 'abuse_sending_paused', mail: (r) => ['wir haben den E-Mail- und SMS-Versand deines Kontos vorübergehend pausiert.', `Grund: ${r}`, 'Alles andere funktioniert weiter. Antworte auf diese Nachricht, wenn du die Gründe klären möchtest – wir prüfen das umgehend.'] },
  resume_sending: { label: 'Versand wieder frei', event: 'abuse_sending_resumed', mail: () => ['der E-Mail- und SMS-Versand deines Kontos ist wieder freigegeben.'] },
  unpublish_sites: { label: 'Websites offline', event: 'abuse_sites_offline', mail: (r) => ['wir haben die Websites und Formulare deines Kontos vorübergehend offline genommen.', `Grund: ${r}`, 'Du kannst weiter arbeiten und die Inhalte bearbeiten. Antworte auf diese Nachricht, um die Entscheidung prüfen zu lassen.'] },
  publish_sites: { label: 'Websites wieder online', event: 'abuse_sites_online', mail: () => ['deine Websites und Formulare sind wieder online.'] },
  suspend: { label: 'Konto gesperrt', event: 'abuse_suspended', mail: (r) => ['wir haben dein Konto gesperrt. Websites, Formulare und der Versand sind offline, die Anmeldung ist bis auf den Datenexport gesperrt.', `Grund: ${r}`, 'Du kannst gegen diese Entscheidung Widerspruch einlegen – antworte einfach auf diese Nachricht.'] },
  unsuspend: { label: 'Sperre aufgehoben', event: 'abuse_unsuspended', mail: () => ['die Sperre deines Kontos ist aufgehoben.'] },
};

/** What a suspended customer may still reach: their own login (profile, sessions, 2FA), branding, the cloud account summary, the data export, signing out. */
const SUSPENDED_OPEN = /^\/api\/(me(\/[a-z0-9/-]+)?|branding\/me|cloud\/me|cloud\/export|auth\/logout)$/;

export const cloudAbuseModule: Module = {
  name: 'cloud-abuse',
  migrations: [
    [
      '001-init',
      `CREATE TABLE abuse_reports (
        id TEXT PRIMARY KEY, category TEXT NOT NULL, urls TEXT NOT NULL, explanation TEXT NOT NULL,
        reporter_name TEXT NOT NULL DEFAULT '', reporter_email TEXT NOT NULL DEFAULT '', good_faith INTEGER NOT NULL DEFAULT 0,
        tenant_id TEXT, status TEXT NOT NULL DEFAULT 'new', decision TEXT NOT NULL DEFAULT '', decided_at TEXT, decided_by TEXT NOT NULL DEFAULT '',
        ip_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX abuse_reports_status ON abuse_reports(status, created_at);
      CREATE TABLE cloud_abuse_flags (
        tenant_id TEXT PRIMARY KEY, sending_paused_at TEXT, sending_reason TEXT NOT NULL DEFAULT '', sending_auto INTEGER NOT NULL DEFAULT 0,
        sites_offline_at TEXT, sites_reason TEXT NOT NULL DEFAULT '', suspended_at TEXT, suspend_reason TEXT NOT NULL DEFAULT '',
        window_from TEXT, updated_at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    if (!cloudEnabled(app)) return;
    const { db, router } = app;

    const settings = (): Settings => {
      const row = db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', 'cloud_abuse');
      const v = row ? (JSON.parse(row.value) as Partial<Settings>) : {};
      return { abuse_email: v.abuse_email ?? '', auto_pause: v.auto_pause !== false };
    };
    const flagsOf = (tid: string) => db.get<Flags>('SELECT * FROM cloud_abuse_flags WHERE tenant_id = ?', tid);
    const setFlags = (tid: string, patch: Partial<Flags>) => {
      if (!flagsOf(tid)) db.insert('cloud_abuse_flags', { tenant_id: tid, updated_at: now() });
      const p = { ...patch, updated_at: now() };
      db.run(`UPDATE cloud_abuse_flags SET ${Object.keys(p).map((k) => `${k} = ?`).join(', ')} WHERE tenant_id = ?`, ...Object.values(p), tid);
    };
    const flagsOfLocation = (lid: string) => {
      const t = tenantOfLocation(app, lid);
      return t ? flagsOf(t.id) : undefined;
    };
    const support = () => cloudSupport(app);
    const sendingBlocked = (lid: string): string | undefined => {
      const f = flagsOfLocation(lid);
      if (f?.suspended_at) return `Konto gesperrt: ${f.suspend_reason}`;
      if (f?.sending_paused_at) return `Versand pausiert: ${f.sending_reason}${support() ? ` – Fragen an ${support()}` : ''}`;
      return undefined;
    };
    const sitesBlocked = (lid: string): string | undefined => {
      const f = flagsOfLocation(lid);
      return f?.suspended_at ? f.suspend_reason || 'gesperrt' : f?.sites_offline_at ? f.sites_reason || 'offline' : undefined;
    };
    app.services.cloudAbuse = { flags: flagsOf, sendingBlocked, sitesBlocked, settings };

    // --- sending: in front of the plan's usage gate -------------------------------------------------------------------
    const prevGate = app.services.usageGate as ((lid: string, kind: 'email' | 'sms' | 'ai') => string | undefined) | undefined;
    app.services.usageGate = (lid: string, kind: 'email' | 'sms' | 'ai') => (kind !== 'ai' ? sendingBlocked(lid) : undefined) ?? prevGate?.(lid, kind);

    // --- suspended accounts: no customer route but the few above ----------------------------------------------------
    app.guards.push((ctx: Ctx, auth: Auth) => {
      const u = ctx.user;
      if (u?.role === 'admin') return;
      let t: Tenant | undefined;
      if (auth === 'location' && ctx.locationId) t = tenantOfLocation(app, ctx.locationId);
      else if (auth === 'user' && u) t = tenantOfUser(app, u.id)?.tenant;
      if (!t) return;
      const f = flagsOf(t.id);
      if (!f?.suspended_at || SUSPENDED_OPEN.test(ctx.path)) return;
      throw new HttpError(403, `Dieses Konto ist gesperrt: ${f.suspend_reason}.${support() ? ` Fragen und Widerspruch: ${support()}.` : ''} Deine Daten kannst du weiter exportieren.`);
    });

    // --- sites and forms offline: the public routes of a blocked customer answer 410 --------------------------------
    const offlinePage = () => {
      const r = servePage(messagePage(pageCtx(app), { title: 'Nicht verfügbar', text: 'Diese Seite ist derzeit nicht verfügbar.' }), 410);
      r.headers['x-robots-tag'] = 'noindex';
      return r;
    };
    const locationOfPublic = (pattern: string, params: Record<string, string>): string | undefined => {
      if (pattern.startsWith('/p/:funnel')) return db.get<{ location_id: string }>('SELECT location_id FROM funnels WHERE slug = ?', params.funnel)?.location_id;
      if (pattern.startsWith('/f/:id')) return db.get<{ location_id: string }>('SELECT location_id FROM forms WHERE id = ?', params.id)?.location_id;
      return undefined;
    };
    app.router.wrappers.push((route, next) =>
      route.auth === 'public' && (route.pattern.startsWith('/p/:funnel') || route.pattern.startsWith('/f/:id'))
        ? (ctx) => {
            const lid = locationOfPublic(route.pattern, ctx.params);
            return lid && sitesBlocked(lid) ? offlinePage() : next(ctx);
          }
        : next,
    );

    // --- actions ------------------------------------------------------------------------------------------------------
    /** Applies one action; returns the flags. `auto` marks the automatic pause. */
    async function act(t: Tenant, action: string, reason: string, o: { by: string; notify?: boolean; auto?: boolean } = { by: 'Betreiber' }) {
      const a = ACTIONS[action];
      if (!a) throw bad(`Unbekannte Maßnahme (${Object.keys(ACTIONS).join(', ')})`);
      const needsReason = ['pause_sending', 'unpublish_sites', 'suspend'].includes(action);
      if (needsReason && reason.length < 5) throw bad('Bitte den Grund angeben – der Kunde bekommt ihn mitgeteilt (DSA Art. 17).');
      const at = now();
      if (action === 'pause_sending') setFlags(t.id, { sending_paused_at: at, sending_reason: reason, sending_auto: o.auto ? 1 : 0 });
      else if (action === 'resume_sending') setFlags(t.id, { sending_paused_at: null, sending_reason: '', sending_auto: 0, window_from: at });
      else if (action === 'unpublish_sites') setFlags(t.id, { sites_offline_at: at, sites_reason: reason });
      else if (action === 'publish_sites') setFlags(t.id, { sites_offline_at: null, sites_reason: '' });
      else if (action === 'suspend') setFlags(t.id, { suspended_at: at, suspend_reason: reason });
      else if (action === 'unsuspend') setFlags(t.id, { suspended_at: null, suspend_reason: '', window_from: at });
      logCloudEvent(app, t.id, a.event, `${o.auto ? 'Automatisch: ' : ''}${reason || a.label}`);
      app.services.audit?.({ action: `cloud.${a.event}`, summary: `${t.name}: ${a.label}${reason ? ` – ${reason}` : ''}`, actor: o.by, entityId: t.id });
      if (o.notify !== false && a.mail && t.email) {
        await sendCloudMail(app, 'notice', t.email, { subject: `${a.label} – ${t.name}`, name: t.name, lines: ['Hallo,', ...a.mail(reason)], company: t.name }, { tenantId: t.id });
      }
      return flagsOf(t.id);
    }
    app.services.cloudAbuse.act = act;

    // --- auto-pause on complaints and bounces -------------------------------------------------------------------------
    async function autoPause(): Promise<{ tenant: string; reason: string }[]> {
      if (!settings().auto_pause) return [];
      const paused: { tenant: string; reason: string }[] = [];
      for (const t of db.all<Tenant>('SELECT * FROM cloud_tenants WHERE deleted_at IS NULL')) {
        const f = flagsOf(t.id);
        if (f?.sending_paused_at || f?.suspended_at) continue;
        const locs = tenantLocationIds(app, t.id);
        if (!locs.length) continue;
        const rows = db.all<{ status: string }>(
          `SELECT status FROM messages WHERE location_id IN (${locs.map(() => '?').join(',')}) AND direction = 'out' AND channel = 'email'
             AND status IN ('sent', 'delivered', 'bounced', 'complained') AND created_at > ? ORDER BY created_at DESC LIMIT ${WINDOW}`,
          ...locs,
          f?.window_from ?? '',
        );
        const reason = pauseReason(rows.map((r) => r.status));
        if (!reason) continue;
        await act(t, 'pause_sending', reason, { by: 'Automatisch', auto: true });
        paused.push({ tenant: t.id, reason });
        app.services.opsAlert?.event({ key: `abuse_autopause:${t.id}`, severity: 'warning', title: `Versand von „${t.name}“ automatisch pausiert`, body: `${reason}. Prüfen unter Agentur → Cloud → Missbrauch.` });
      }
      return paused;
    }
    app.services.cloudAbuse.autoPause = autoPause;
    let lastScan = 0;
    app.onTick(async () => {
      if (Date.now() - lastScan < 10 * 60_000) return;
      lastScan = Date.now();
      await autoPause();
      // Notices are kept a year after the decision (proof for the authorities, Art. 15/24 DSA), then go.
      db.run(`DELETE FROM abuse_reports WHERE status IN ('actioned', 'rejected') AND decided_at < ?`, new Date(Date.now() - 365 * 864e5).toISOString());
    });

    // --- the public notice form ---------------------------------------------------------------------------------------
    /** Which customer a reported URL belongs to: a site (path, custom domain or sites domain), a form, a login domain. */
    const tenantForUrl = (raw: string): string | undefined => {
      let u: URL;
      try {
        u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        return undefined;
      }
      const host = u.hostname.toLowerCase();
      const loc = (lid: string | undefined) => (lid ? tenantOfLocation(app, lid)?.id : undefined);
      const p = /^\/p\/([^/]+)/.exec(u.pathname)?.[1];
      const f = /^\/f\/([^/]+)/.exec(u.pathname)?.[1];
      const sitesSlug = slugOfSitesHost(host, sitesDomain());
      const cd = cloudSettings(app).cloud_domain;
      return (
        loc(f ? db.get<{ location_id: string }>('SELECT location_id FROM forms WHERE id = ?', f)?.location_id : undefined) ??
        loc(p ? db.get<{ location_id: string }>('SELECT location_id FROM funnels WHERE slug = ?', decodeURIComponent(p))?.location_id : undefined) ??
        loc(sitesSlug ? db.get<{ location_id: string }>('SELECT location_id FROM funnels WHERE slug = ?', sitesSlug)?.location_id : undefined) ??
        loc(db.get<{ location_id: string }>('SELECT location_id FROM funnels WHERE domain = ? OR domain = ?', host, domainAlias(host) ?? host)?.location_id) ??
        loc(db.get<{ id: string }>(`SELECT id FROM locations WHERE json_extract(settings, '$.branding.app_domain') = ?`, host)?.id) ??
        (cd && host.endsWith(`.${cd}`) ? db.get<{ id: string }>('SELECT id FROM cloud_tenants WHERE slug = ? AND deleted_at IS NULL', host.slice(0, -cd.length - 1))?.id : undefined)
      );
    };
    const hits = new Map<string, number[]>();
    const throttled = (key: string, max: number) => {
      const t = Date.now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < 3600_000);
      if (hits.size > 20_000) hits.clear();
      list.push(t);
      hits.set(key, list);
      return list.length > max;
    };
    const intro = 'Melde Inhalte auf Websites, Formularen oder E-Mails unserer Kunden, die du für rechtswidrig hältst oder die gegen unsere Regeln verstoßen (z. B. Phishing, Spam, Betrug). Wir prüfen jede Meldung und teilen dir unsere Entscheidung mit.';
    const formPage = (o: { values?: ReturnType<typeof cleanReport>['values']; error?: string } = {}, status = 200) =>
      servePage(messagePage(pageCtx(app), { title: 'Missbrauch melden', text: intro, extra: reportForm({ ...o, token: formToken(app), abuseEmail: settings().abuse_email }) }), status);

    router.get('/abuse', 'public', () => formPage());
    router.post('/abuse', 'public', async (ctx) => {
      const b = ctx.body ?? {};
      if (String(b.website ?? '').trim()) return servePage(messagePage(pageCtx(app), { title: 'Danke', text: 'Deine Meldung ist eingegangen.' }));
      const { values, error } = cleanReport(b);
      if (error) return formPage({ values, error }, 400);
      if (!formTokenOk(app, String(b.t ?? ''))) return formPage({ values, error: 'Das ging zu schnell oder die Seite ist veraltet – bitte noch einmal absenden.' }, 400);
      if (throttled(`abuse:${ctx.ip}`, 10)) return formPage({ values, error: 'Zu viele Meldungen von dieser Adresse – bitte in einer Stunde noch einmal oder per E-Mail.' }, 429);
      const tenant = values.urls.map(tenantForUrl).find(Boolean) ?? null;
      const rid = id(10);
      db.insert('abuse_reports', {
        id: rid,
        category: values.category,
        urls: values.urls.join('\n'),
        explanation: values.explanation,
        reporter_name: values.name,
        reporter_email: values.email,
        good_faith: 1,
        tenant_id: tenant,
        status: 'new',
        ip_hash: sha256(`${app.config.secret}:${ctx.ip}`).slice(0, 16),
        created_at: now(),
      });
      if (tenant) logCloudEvent(app, tenant, 'abuse_reported', `${CATEGORIES[values.category]} (Meldung ${rid})`);
      const t = tenant ? tenantById(app, tenant) : undefined;
      app.services.opsAlert?.event({
        key: `abuse_report:${rid}`,
        severity: values.category === 'phishing' || values.category === 'csam' || values.category === 'malware' ? 'critical' : 'warning',
        title: `Missbrauchsmeldung: ${CATEGORIES[values.category]}`,
        body: `${values.urls.slice(0, 3).join(' ')}${t ? ` – Kunde „${t.name}“` : ' – kein Kunde zugeordnet'}. Prüfen unter Agentur → Cloud → Missbrauch (Meldung ${rid}).`,
      });
      if (values.email)
        void sendCloudMail(app, 'notice', values.email, {
          subject: `Eingang deiner Meldung ${rid}`,
          lines: [`Hallo ${values.name || ''}`.trim() + ',', `wir haben deine Meldung (${CATEGORIES[values.category]}) am ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} erhalten und prüfen sie. Aktenzeichen: ${rid}.`, 'Über unsere Entscheidung informieren wir dich per E-Mail.'],
        });
      return servePage(messagePage(pageCtx(app), { title: 'Danke für deine Meldung', text: `Deine Meldung ist eingegangen (Aktenzeichen ${rid}). ${values.email ? 'Du bekommst eine Eingangsbestätigung per E-Mail; ' : ''}wir prüfen sie und handeln, wenn der Inhalt gegen Recht oder unsere Regeln verstößt.` }));
    });

    // --- operator console ---------------------------------------------------------------------------------------------
    const reportOut = (r: Report) => ({ ...r, urls: r.urls.split('\n'), category_label: CATEGORIES[r.category] ?? r.category, status_label: REPORT_STATUS[r.status] ?? r.status, tenant_name: r.tenant_id ? tenantById(app, r.tenant_id)?.name ?? null : null });
    router.get('/api/cloud/console/abuse', 'admin', () => ({
      reports: db.all<Report>('SELECT * FROM abuse_reports ORDER BY created_at DESC LIMIT 300').map(reportOut),
      flagged: db
        .all<Flags & { name: string; email: string }>(
          `SELECT f.*, t.name, t.email FROM cloud_abuse_flags f JOIN cloud_tenants t ON t.id = f.tenant_id
           WHERE t.deleted_at IS NULL AND (f.sending_paused_at IS NOT NULL OR f.sites_offline_at IS NOT NULL OR f.suspended_at IS NOT NULL) ORDER BY f.updated_at DESC`,
        ),
      settings: settings(),
      categories: CATEGORIES,
      statuses: REPORT_STATUS,
      actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.label])),
      public_url: `${app.config.baseUrl}/abuse`,
    }));
    router.patch('/api/cloud/console/abuse/:id', 'admin', async (ctx) => {
      const r = db.get<Report>('SELECT * FROM abuse_reports WHERE id = ?', ctx.params.id);
      if (!r) throw notFound('Meldung nicht gefunden');
      const b = ctx.body ?? {};
      const status = b.status !== undefined ? String(b.status) : r.status;
      if (!REPORT_STATUS[status]) throw bad('Unbekannter Status');
      const decision = b.decision !== undefined ? str(b.decision, 'Begründung', { max: 4000 }) : r.decision;
      const tenant = b.tenant_id !== undefined ? (b.tenant_id ? (tenantById(app, String(b.tenant_id))?.id ?? null) : null) : r.tenant_id;
      if (b.tenant_id && !tenant) throw bad('Kunde nicht gefunden');
      const closing = (status === 'actioned' || status === 'rejected') && r.status !== status;
      if (closing && decision.length < 5) throw bad('Bitte die Entscheidung kurz begründen – der Meldende bekommt sie mitgeteilt (DSA Art. 16 Abs. 5).');
      db.run('UPDATE abuse_reports SET status = ?, decision = ?, tenant_id = ?, decided_at = ?, decided_by = ? WHERE id = ?', status, decision, tenant, closing ? now() : r.decided_at, closing ? ctx.user?.name ?? '' : r.decided_by, r.id);
      if (closing && r.reporter_email && b.notify !== false) {
        await sendCloudMail(app, 'notice', r.reporter_email, {
          subject: `Entscheidung zu deiner Meldung ${r.id}`,
          lines: [`Hallo ${r.reporter_name || ''}`.trim() + ',', status === 'actioned' ? 'wir haben deine Meldung geprüft und Maßnahmen ergriffen.' : 'wir haben deine Meldung geprüft und keinen Verstoß festgestellt, der eine Maßnahme rechtfertigt.', `Begründung: ${decision}`, 'Gegen diese Entscheidung kannst du dich an uns wenden (Antwort auf diese E-Mail) oder den Rechtsweg beschreiten.'],
        });
      }
      return reportOut(db.get<Report>('SELECT * FROM abuse_reports WHERE id = ?', r.id)!);
    });
    router.put('/api/cloud/console/abuse/settings', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const cur = settings();
      const email = b.abuse_email !== undefined ? str(b.abuse_email, 'Abuse-Adresse', { max: 200 }).toLowerCase() : cur.abuse_email;
      if (email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(email)) throw bad('Die Abuse-Adresse ist ungültig');
      const next: Settings = { abuse_email: email, auto_pause: b.auto_pause !== undefined ? !!b.auto_pause : cur.auto_pause };
      db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'cloud_abuse', JSON.stringify(next));
      return next;
    });
    router.post('/api/cloud/console/tenants/:id/abuse', 'admin', async (ctx) => {
      const t = tenantById(app, ctx.params.id);
      if (!t) throw notFound('Kunde nicht gefunden');
      const reason = str(ctx.body?.reason, 'Grund', { max: 1000 });
      return { flags: await act(t, String(ctx.body?.action ?? ''), reason, { by: ctx.user?.name || 'Betreiber', notify: ctx.body?.notify !== false }) };
    });
    router.get('/api/cloud/console/tenants/:id/abuse', 'admin', (ctx) => {
      const t = tenantById(app, ctx.params.id);
      if (!t) throw notFound('Kunde nicht gefunden');
      return { flags: flagsOf(t.id) ?? null, reports: db.all<Report>('SELECT * FROM abuse_reports WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', t.id).map(reportOut) };
    });
  },
};

/** The abuse service of an app (cloud mode only). */
export const cloudAbuse = (app: App) => app.services.cloudAbuse as { sendingBlocked(lid: string): string | undefined; sitesBlocked(lid: string): string | undefined; autoPause(): Promise<{ tenant: string; reason: string }[]> } | undefined;
