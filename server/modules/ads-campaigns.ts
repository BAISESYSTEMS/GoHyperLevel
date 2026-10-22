import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { addDaysYmd, ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { cleanSpec, type AdSpec } from '../services/ads-manager.js';
import { applyStatus, campaignOut, decide, localOf, mustCampaign, publish, refreshRemote, review, spend, type CampaignRow } from '../services/ads-ops.js';
import { PLATFORMS, activity, audit, canManage, connected, googleCreds, loadConnection, maxDailyBudget, metaCreds, type Platform } from '../services/ads-store.js';

/**
 * Campaign manager: drafts, the review before publishing, publishing (always PAUSED), the campaign list with metrics
 * (the ad reporting's numbers), pause/resume, budget changes, duplicates and the approvals every spend change
 * from an API key, MCP client or agent goes through. Platform calls: services/ads-ops.ts.
 */

const REMOTE_REFRESH_MS = 3 * 3600_000;

export const adsCampaignsModule: Module = {
  name: 'ads-campaigns',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_campaigns (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', spec TEXT NOT NULL DEFAULT '{}', remote TEXT NOT NULL DEFAULT '{}', remote_id TEXT,
        currency TEXT NOT NULL DEFAULT 'EUR', last_error TEXT, created_by TEXT, created_via TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
      );
      CREATE INDEX ads_campaigns_loc ON ads_campaigns(location_id, updated_at);
      CREATE INDEX ads_campaigns_remote ON ads_campaigns(location_id, platform, remote_id);
      CREATE TABLE ads_remote (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, platform TEXT NOT NULL, campaign_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'other', raw_status TEXT NOT NULL DEFAULT '', objective TEXT NOT NULL DEFAULT '',
        budget_cents INTEGER, budget_type TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (location_id, platform, campaign_id)
      );
      CREATE TABLE ads_approvals (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        platform TEXT NOT NULL, campaign_id TEXT, remote_id TEXT NOT NULL, campaign_name TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', summary TEXT NOT NULL,
        requested_by TEXT, requested_by_name TEXT NOT NULL DEFAULT '', requested_via TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, decided_by_name TEXT NOT NULL DEFAULT '', decided_at TEXT, result TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE INDEX ads_approvals_loc ON ads_approvals(location_id, status, created_at);
      CREATE TABLE ads_activity (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        campaign_id TEXT, platform TEXT, remote_id TEXT, kind TEXT NOT NULL, summary TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT '', via TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX ads_activity_loc ON ads_activity(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // --- helpers --------------------------------------------------------------------------------------------------
    /** `:id` is a HyperLevel campaign id, or `meta:<id>` / `google:<id>` for a campaign that only exists at the platform. */
    const target = (locationId: string, param: string): { platform: Platform; remoteId: string; local?: CampaignRow; name: string } => {
      const m = /^(meta|google):(\d{3,25})$/.exec(param);
      if (m) {
        const platform = m[1] as Platform;
        const r = db.get<{ name: string }>('SELECT name FROM ads_remote WHERE location_id = ? AND platform = ? AND campaign_id = ?', locationId, platform, m[2]);
        const local = localOf(app, locationId, platform, m[2]);
        if (!r && !local) throw notFound('Kampagne nicht gefunden');
        return { platform, remoteId: m[2], local, name: local?.name ?? r!.name };
      }
      const local = mustCampaign(app, locationId, param);
      if (!local.remote_id) throw bad('Die Kampagne ist noch nicht angelegt – erst prüfen und anlegen');
      return { platform: local.platform, remoteId: local.remote_id, local, name: local.name };
    };

    const specFrom = (b: any, existing?: AdSpec): AdSpec => cleanSpec(b?.spec ?? b, existing ? { ...existing } : {});

    const create = (ctx: Ctx, spec: AdSpec): CampaignRow => {
      const conn = loadConnection(app, ctx.locationId, spec.platform);
      const row = {
        id: id(),
        location_id: ctx.locationId,
        platform: spec.platform,
        kind: spec.kind,
        name: spec.name || 'Neue Kampagne',
        goal: spec.goal,
        status: 'draft',
        spec: JSON.stringify(spec),
        remote: '{}',
        currency: String(conn?.config.currency || 'EUR'),
        created_by: ctx.user?.id ?? null,
        created_via: ctx.via ?? '',
        created_at: now(),
        updated_at: now(),
      };
      db.insert('ads_campaigns', row);
      audit(app, ctx, 'ads.campaign.draft', `Kampagnen-Entwurf „${row.name}“ (${spec.platform === 'meta' ? 'Meta' : 'Google Ads'}) angelegt`, { locationId: ctx.locationId, entityId: row.id });
      activity(app, ctx.locationId, { campaignId: row.id, platform: spec.platform, kind: 'draft', summary: `Entwurf „${row.name}“ angelegt`, actor: ctx.user?.name, via: ctx.via });
      return mustCampaign(app, ctx.locationId, row.id);
    };

    /** What the wizard needs to know about the connections (campaign area; the connection screen itself is settings). */
    router.get('/api/ads/overview', 'location', (ctx) => {
      const m = loadConnection(app, ctx.locationId, 'meta');
      const g = loadConnection(app, ctx.locationId, 'google');
      const mc = metaCreds(m);
      const gc = googleCreds(app, g);
      return {
        connected: { meta: connected(app, 'meta', m), google: connected(app, 'google', g) },
        meta: { account: mc.adAccountId ? { id: mc.adAccountId, name: m?.config.ad_account_name ?? '', currency: m?.config.currency ?? 'EUR' } : null, page: mc.pageId ? { id: mc.pageId, name: m?.config.page_name ?? '' } : null, pixel_id: mc.pixelId, can_manage: canManage('meta', m) },
        google: { account: gc.customerId ? { id: gc.customerId, name: g?.config.customer_name ?? '', currency: g?.config.currency ?? 'EUR' } : null, can_manage: canManage('google', g) },
        max_daily_budget_cents: maxDailyBudget(app, ctx.locationId),
      };
    });

    // --- review & drafts --------------------------------------------------------------------------------------------
    /** The review screen for a spec that is not saved yet (the wizard calls it on its last step). */
    router.post('/api/ads/review', 'location', (ctx) => review(app, ctx.locationId, specFrom(ctx.body)));

    router.get('/api/ads/campaigns/:id/review', 'location', (ctx) => {
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      return review(app, ctx.locationId, c.spec);
    });

    router.post('/api/ads/campaigns', 'location', (ctx) => campaignOut(create(ctx, specFrom(ctx.body))));

    router.get('/api/ads/campaigns/:id', 'location', (ctx) => {
      const m = /^(meta|google):/.exec(ctx.params.id);
      if (m) {
        const t = target(ctx.locationId, ctx.params.id);
        return { id: null, remote_id: t.remoteId, platform: t.platform, name: t.name, managed: false, activity: db.all('SELECT * FROM ads_activity WHERE location_id = ? AND platform = ? AND remote_id = ? ORDER BY created_at DESC LIMIT 50', ctx.locationId, t.platform, t.remoteId) };
      }
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      return { ...campaignOut(c), managed: true, activity: db.all('SELECT * FROM ads_activity WHERE location_id = ? AND campaign_id = ? ORDER BY created_at DESC LIMIT 50', ctx.locationId, c.id) };
    });

    router.patch('/api/ads/campaigns/:id', 'location', (ctx) => {
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      if (c.status !== 'draft' && c.status !== 'error') throw new HttpError(409, 'Eine angelegte Kampagne lässt sich hier nicht mehr ändern – Budget und Status über die Liste, alles andere in Meta bzw. Google Ads');
      const spec = specFrom(ctx.body, c.spec);
      db.run(`UPDATE ads_campaigns SET spec = ?, name = ?, goal = ?, kind = ?, platform = ?, updated_at = ?, last_error = NULL, status = 'draft' WHERE id = ? AND location_id = ?`, JSON.stringify(spec), spec.name || c.name, spec.goal, spec.kind, spec.platform, now(), c.id, ctx.locationId);
      return campaignOut(mustCampaign(app, ctx.locationId, c.id));
    });

    router.delete('/api/ads/campaigns/:id', 'location', (ctx) => {
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      if (c.status !== 'draft' && c.status !== 'error') throw new HttpError(409, 'Eine angelegte Kampagne bitte in Meta bzw. Google Ads löschen – hier lässt sie sich pausieren');
      db.run('DELETE FROM ads_campaigns WHERE id = ? AND location_id = ?', c.id, ctx.locationId);
      audit(app, ctx, 'ads.campaign.delete', `Kampagnen-Entwurf „${c.name}“ gelöscht`, { locationId: ctx.locationId, entityId: c.id });
      return { ok: true };
    });

    router.post('/api/ads/campaigns/:id/duplicate', 'location', (ctx) => {
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      const spec = cleanSpec({ ...c.spec, name: `${c.name} (Kopie)` });
      // A copy is a fresh draft: nothing of the original's platform ids, always paused when published.
      const copy = create(ctx, spec);
      audit(app, ctx, 'ads.campaign.duplicate', `Kampagne „${c.name}“ dupliziert`, { locationId: ctx.locationId, entityId: copy.id });
      return campaignOut(copy);
    });

    /** Creates the campaign at the platform – paused – for exactly the version that was reviewed. */
    router.post('/api/ads/campaigns/:id/publish', 'location', async (ctx) => {
      const c = mustCampaign(app, ctx.locationId, ctx.params.id);
      const done = await publish(app, ctx, c, String(ctx.body?.review_hash ?? ''));
      return { ...campaignOut(done), message: 'Pausiert angelegt – es wird nichts ausgegeben, bis du die Kampagne aktivierst.' };
    });

    // --- status & budget ------------------------------------------------------------------------------------------------
    router.post('/api/ads/campaigns/:id/status', 'location', async (ctx) => {
      const t = target(ctx.locationId, ctx.params.id);
      const status = String(ctx.body?.status ?? '');
      if (status !== 'paused' && status !== 'active') throw bad('Status: paused oder active');
      if (status === 'paused') {
        // Stopping never costs money: no confirmation, whoever asks.
        await applyStatus(app, ctx, { locationId: ctx.locationId, platform: t.platform, remoteId: t.remoteId, status: 'paused' });
        return { status: 'done', summary: `„${t.name}“ pausiert` };
      }
      return spend(app, ctx, { locationId: ctx.locationId, platform: t.platform, remoteId: t.remoteId, action: 'activate' }, ctx.body?.confirm === true);
    });

    router.post('/api/ads/campaigns/:id/budget', 'location', async (ctx) => {
      const t = target(ctx.locationId, ctx.params.id);
      const cents = Math.round(Number(ctx.body?.amount_cents));
      if (!(cents > 0)) throw bad('Budget (amount_cents) fehlt');
      const type = ctx.body?.type === 'lifetime' ? 'lifetime' : ctx.body?.type === 'daily' ? 'daily' : undefined;
      return spend(app, ctx, { locationId: ctx.locationId, platform: t.platform, remoteId: t.remoteId, action: 'budget', type, amountCents: cents }, ctx.body?.confirm === true);
    });

    // --- approvals ---------------------------------------------------------------------------------------------------------
    router.get('/api/ads/approvals', 'location', (ctx) => {
      db.run(`UPDATE ads_approvals SET status = 'expired' WHERE location_id = ? AND status = 'pending' AND expires_at < ?`, ctx.locationId, now());
      const all = ctx.query.get('status') === 'all';
      return db.all(`SELECT * FROM ads_approvals WHERE location_id = ? ${all ? '' : `AND status = 'pending'`} ORDER BY created_at DESC LIMIT 100`, ctx.locationId).map((a) => ({ ...a, payload: JSON.parse(a.payload || '{}') }));
    });
    router.post('/api/ads/approvals/:id/approve', 'location', (ctx) => decide(app, ctx, ctx.locationId, ctx.params.id, true));
    router.post('/api/ads/approvals/:id/reject', 'location', (ctx) => decide(app, ctx, ctx.locationId, ctx.params.id, false));

    router.get('/api/ads/activity', 'location', (ctx) => db.all('SELECT * FROM ads_activity WHERE location_id = ? ORDER BY created_at DESC LIMIT 100', ctx.locationId));

    // --- list with metrics ---------------------------------------------------------------------------------------------------
    /** Default range of the lists: the last 30 days up to today in the sub-account's time zone (like /api/ads/report), not the UTC date. */
    const localLast30 = (locationId: string) => {
      const to = ymdInTz(new Date(), app.location(locationId)?.timezone || 'Europe/Berlin');
      return { from: addDaysYmd(to, -29), to };
    };

    const metricsOf = (r: any) => ({ spend_cents: r.spend_cents, impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, platform_leads: r.platform_leads, crm_leads: r.crm_leads, cpl_cents: r.cpl_cents, revenue_cents: r.revenue_cents, roas: r.roas, currency: r.currency });

    /** HyperLevel's campaigns, the ad account's other campaigns and the numbers of the ad reporting in one list. */
    const listAll = (locationId: string, from: string, to: string, model: 'first' | 'last') => {
      const report = app.services.adsReport?.(locationId, from, to, model) ?? { rows: [], totals: null, attribution: false };
      const metrics = new Map<string, any>((report.rows as any[]).map((r) => [`${r.platform}:${r.campaign_id}`, r]));
      const remotes = db.all('SELECT * FROM ads_remote WHERE location_id = ?', locationId);
      const byRemote = new Map(remotes.map((r) => [`${r.platform}:${r.campaign_id}`, r]));
      const rows: any[] = [];
      const seen = new Set<string>();
      for (const l of db.all('SELECT * FROM ads_campaigns WHERE location_id = ? ORDER BY updated_at DESC', locationId)) {
        const c = campaignOut({ ...l, spec: JSON.parse(l.spec || '{}'), remote: JSON.parse(l.remote || '{}') } as CampaignRow);
        const key = c.remote_id ? `${c.platform}:${c.remote_id}` : '';
        const r = key ? byRemote.get(key) : undefined;
        if (key) seen.add(key);
        const m = key ? metrics.get(key) : undefined;
        rows.push({
          key: c.id,
          id: c.id,
          remote_id: c.remote_id,
          platform: c.platform,
          name: c.name,
          kind: c.kind,
          goal: c.goal,
          status: c.status,
          managed: true,
          budget_cents: r?.budget_cents ?? c.spec.budget?.amount_cents ?? null,
          budget_type: r?.budget_type ?? c.spec.budget?.type ?? null,
          currency: c.currency,
          last_error: c.last_error,
          updated_at: c.updated_at,
          metrics: m ? metricsOf(m) : null,
        });
      }
      for (const r of remotes) {
        const key = `${r.platform}:${r.campaign_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const m = metrics.get(key);
        rows.push({ key, id: null, remote_id: r.campaign_id, platform: r.platform, name: r.name, kind: null, goal: r.objective, status: r.status, managed: false, budget_cents: r.budget_cents, budget_type: r.budget_type, currency: m?.currency ?? 'EUR', last_error: null, updated_at: r.updated_at, metrics: m ? metricsOf(m) : null });
      }
      // Campaigns with numbers but gone from the ad account (deleted there).
      for (const [key, m] of metrics) {
        if (seen.has(key)) continue;
        rows.push({ key, id: null, remote_id: m.campaign_id, platform: m.platform, name: m.campaign_name || m.campaign_id, kind: null, goal: '', status: 'ended', managed: false, budget_cents: null, budget_type: null, currency: m.currency, last_error: null, updated_at: null, metrics: metricsOf(m) });
      }
      return { rows, report };
    };

    router.get('/api/ads/campaigns', 'location', async (ctx) => {
      const ok = (s: string | null) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s : '');
      const last30 = localLast30(ctx.locationId);
      const to = ok(ctx.query.get('to')) || last30.to;
      const from = ok(ctx.query.get('from')) || last30.from;
      if (from > to) throw bad('„Von“ liegt nach „Bis“');
      const model = ctx.query.get('model') === 'last' ? 'last' : 'first';
      const errors: Record<string, string> = {};
      if (ctx.query.get('refresh') === '1') {
        for (const p of PLATFORMS) {
          if (!connected(app, p, loadConnection(app, ctx.locationId, p))) continue;
          try {
            await refreshRemote(app, ctx.locationId, p);
          } catch (e) {
            errors[p] = (e as Error).message;
          }
        }
      }
      const { rows, report } = listAll(ctx.locationId, from, to, model);
      db.run(`UPDATE ads_approvals SET status = 'expired' WHERE location_id = ? AND status = 'pending' AND expires_at < ?`, ctx.locationId, now());
      return {
        from,
        to,
        model,
        campaigns: rows,
        totals: report.totals,
        attribution: report.attribution,
        connected: { meta: connected(app, 'meta', loadConnection(app, ctx.locationId, 'meta')), google: connected(app, 'google', loadConnection(app, ctx.locationId, 'google')) },
        approvals_pending: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ads_approvals WHERE location_id = ? AND status = 'pending'`, ctx.locationId)!.n,
        errors,
      };
    });

    /** What the MCP tool and the agent read: the ad report plus the ids needed to pause or change a campaign. */
    router.get('/api/ads/insights', 'location', (ctx) => {
      const ok = (s: string | null) => (s && /^\d{4}-\d\d-\d\d$/.test(s) ? s : '');
      const last30 = localLast30(ctx.locationId);
      const to = ok(ctx.query.get('to')) || last30.to;
      const from = ok(ctx.query.get('from')) || last30.from;
      if (from > to) throw bad('„Von“ liegt nach „Bis“');
      const platform = ctx.query.get('platform');
      const { rows, report } = listAll(ctx.locationId, from, to, ctx.query.get('model') === 'last' ? 'last' : 'first');
      return {
        from,
        to,
        attribution: report.attribution,
        totals: report.totals,
        campaigns: rows
          .filter((r) => !platform || r.platform === platform)
          .map((r) => ({ id: r.id, campaign_ref: r.id ?? `${r.platform}:${r.remote_id}`, platform: r.platform, remote_id: r.remote_id, name: r.name, status: r.status, managed: r.managed, budget_cents: r.budget_cents, budget_type: r.budget_type, ...(r.metrics ?? {}) })),
      };
    });

    // --- remote refresh --------------------------------------------------------------------------------------------------------
    router.post('/api/ads/campaigns/refresh', 'location', async (ctx) => {
      const list = ctx.body?.platform ? [ctx.body.platform as Platform] : PLATFORMS.filter((p) => connected(app, p, loadConnection(app, ctx.locationId, p)));
      if (!list.length) throw bad('Noch kein Werbekonto verbunden');
      const out: Record<string, number> = {};
      for (const p of list) {
        if (!PLATFORMS.includes(p)) throw bad('Unbekannte Plattform');
        out[p] = await refreshRemote(app, ctx.locationId, p);
      }
      return out;
    });

    // Keeps the status in the list close to reality (somebody may have paused a campaign in Meta or Google Ads).
    const last = new Map<string, number>();
    let ticking = false;
    app.onTick(async () => {
      if (ticking) return;
      ticking = true;
      try {
        let n = 0;
        for (const r of db.all<{ location_id: string; platform: Platform }>(`SELECT location_id, platform FROM ads_accounts WHERE enabled = 1`)) {
          const key = `${r.location_id}:${r.platform}`;
          if (Date.now() - (last.get(key) ?? 0) < REMOTE_REFRESH_MS) continue;
          if (!connected(app, r.platform, loadConnection(app, r.location_id, r.platform))) continue;
          last.set(key, Date.now());
          await refreshRemote(app, r.location_id, r.platform).catch((e) => console.warn('[ads] refresh', key, (e as Error).message));
          if (++n >= 5) break;
        }
        db.run(`UPDATE ads_approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`, now());
      } finally {
        ticking = false;
      }
    });

    app.services.adsOps = { target, listAll };
  },
};

