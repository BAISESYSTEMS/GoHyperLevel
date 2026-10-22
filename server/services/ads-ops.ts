import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { pageUrl } from '../modules/funnels.js';
import { AdsError } from './ads.js';
import * as google from './ads-google.js';
import { cleanSpec, reviewHash, reviewOf, tracking, validateSpec, type AdSpec, type Problems, type Review } from './ads-manager.js';
import * as meta from './ads-meta.js';
import { PLATFORM_LABEL, activity, audit, canManage, connected, currencyDivisor, fetcherOf, googleAuth, isHuman, loadConnection, maxDailyBudget, metaCreds, relay, setConnectionError, type Connection, type Platform } from './ads-store.js';

/**
 * Operations of the ads manager on top of the platform clients: preparing and reviewing a campaign, publishing it
 * (always PAUSED), switching it on or off, changing its budget, keeping the campaign list of the ad account in step,
 * and the rule every spend change follows: a person confirms it in the web app; API keys, MCP clients, the agent and
 * automations only create an approval that a person decides on (see `spend`).
 */

const REMOTE_ID = /^\d{3,25}$/;
export const checkRemoteId = (v: unknown): string => {
  const s = String(v ?? '').trim();
  if (!REMOTE_ID.test(s)) throw bad('Ungültige Kampagnen-ID');
  return s;
};

export interface CampaignRow {
  id: string;
  location_id: string;
  platform: Platform;
  kind: string;
  name: string;
  goal: string;
  status: 'draft' | 'publishing' | 'paused' | 'active' | 'error';
  spec: AdSpec;
  remote: Record<string, any>;
  remote_id: string | null;
  currency: string;
  last_error: string | null;
  created_by: string | null;
  created_via: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export const getCampaign = (app: App, locationId: string, cid: string): CampaignRow | undefined => {
  const row = app.db.get('SELECT * FROM ads_campaigns WHERE id = ? AND location_id = ?', cid, locationId);
  return row ? (parseJson(row, ['spec', 'remote']) as CampaignRow) : undefined;
};

export function mustCampaign(app: App, locationId: string, cid: string): CampaignRow {
  const row = getCampaign(app, locationId, cid);
  if (!row) throw notFound('Kampagne nicht gefunden');
  return row;
}

/** The campaign as the browser sees it (no platform internals beyond ids). */
export const campaignOut = (c: CampaignRow) => ({
  id: c.id,
  platform: c.platform,
  kind: c.kind,
  name: c.name,
  goal: c.goal,
  status: c.status,
  spec: c.spec,
  remote_id: c.remote_id,
  currency: c.currency,
  last_error: c.last_error,
  created_via: c.created_via,
  created_at: c.created_at,
  updated_at: c.updated_at,
  published_at: c.published_at,
});

// --- preparation & review -----------------------------------------------------------------------------------------

/** The public address of a funnel page, or the link as typed (http/https only). */
export function resolveLink(app: App, locationId: string, spec: AdSpec): string {
  const l = spec.creative.link ?? {};
  if (l.funnel_id) {
    const f = parseJson(app.db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', l.funnel_id, locationId), ['settings']);
    if (!f) throw bad('Funnel nicht gefunden');
    const pages = app.db.all('SELECT * FROM funnel_pages WHERE funnel_id = ? ORDER BY position, created_at', f.id);
    const page = l.page_id ? pages.find((p) => p.id === l.page_id) : pages[0];
    if (l.page_id && !page) throw bad('Funnel-Seite nicht gefunden');
    return pageUrl(app, f, page, !page || pages[0]?.id === page.id);
  }
  if (!l.url) return '';
  try {
    const u = new URL(l.url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    return u.toString();
  } catch {
    throw bad('Link ungültig – er muss mit https:// beginnen');
  }
}

const MEDIA_MAX = 15 * 1024 * 1024;

interface Upload {
  id: string;
  name: string;
  file: string;
  mime: string;
  size: number;
}

const uploadOf = (app: App, locationId: string, uploadId: string): Upload | undefined => app.db.get<Upload>('SELECT id, name, file, mime, size FROM uploads WHERE id = ? AND location_id = ?', uploadId, locationId);

function readUpload(app: App, u: Upload): Buffer {
  const path = join(app.config.dataDir, 'uploads', u.file);
  if (!existsSync(path)) throw bad(`Datei „${u.name}“ fehlt in der Mediathek`);
  if (u.size > MEDIA_MAX) throw bad(`„${u.name}“ ist größer als 15 MB`);
  return readFileSync(path);
}

export interface Prepared {
  conn: Connection | undefined;
  spec: AdSpec;
  link: string;
  currency: string;
  accountName: string;
  pageName: string;
  audiences: string[];
  excluded: string[];
  audienceNames: string[];
  leadForm?: { id: string; form_id: string; name: string };
  mediaNames: string[];
  problems: Problems;
  hash: string;
}

export function prepare(app: App, locationId: string, specIn: AdSpec): Prepared {
  const spec = cleanSpec(specIn);
  const conn = loadConnection(app, locationId, spec.platform);
  const ready = connected(app, spec.platform, conn);
  const meta_ = metaCreds(conn);
  let link = '';
  const linkError: string[] = [];
  try {
    link = resolveLink(app, locationId, spec);
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    linkError.push(e.message);
  }
  const currency = String(conn?.config.currency || 'EUR');
  const accountName = String(conn?.config[spec.platform === 'meta' ? 'ad_account_name' : 'customer_name'] || (spec.platform === 'meta' ? meta_.adAccountId : conn?.config.customer_id) || '–');
  const audiences: string[] = [];
  const excluded: string[] = [];
  const audienceNames: string[] = [];
  const missing: string[] = [];
  const pick = (ids: string[] | undefined, into: string[]) => {
    for (const aid of ids ?? []) {
      const a = app.db.get<{ name: string; platform_id: string; platform: string; status: string }>('SELECT name, platform_id, platform, status FROM ads_audiences WHERE id = ? AND location_id = ?', aid, locationId);
      if (!a || a.platform !== spec.platform) missing.push('Eine gewählte Zielgruppe gibt es nicht (mehr) für diese Plattform');
      else if (a.status !== 'ready' || !a.platform_id) missing.push(`Zielgruppe „${a.name}“ ist noch nicht bereit`);
      else {
        into.push(a.platform_id);
        audienceNames.push(a.name);
      }
    }
  };
  pick(spec.audience.audience_ids, audiences);
  pick(spec.audience.exclude_audience_ids, excluded);
  const lf = spec.lead_form_id ? app.db.get<{ id: string; form_id: string; name: string }>('SELECT id, form_id, name FROM ads_leadforms WHERE id = ? AND location_id = ?', spec.lead_form_id, locationId) : undefined;
  const mediaNames: string[] = [];
  for (const m of spec.creative.media ?? []) {
    const u = uploadOf(app, locationId, m.upload_id);
    if (u) mediaNames.push(u.name);
    else missing.push('Ein gewähltes Bild oder Video gibt es nicht mehr in der Mediathek');
  }
  const problems = validateSpec(spec, {
    maxDailyCents: maxDailyBudget(app, locationId),
    hasPixel: spec.platform === 'meta' ? !!meta_.pixelId : false,
    hasPage: !!meta_.pageId,
    hasLeadForm: !!lf?.form_id,
    link,
  });
  if (!ready) problems.errors.unshift(`${PLATFORM_LABEL[spec.platform]} ist noch nicht verbunden (Anzeigen → Verbindungen)`);
  else if (!canManage(spec.platform, conn)) problems.errors.unshift('Der Zugang darf nur lesen – bitte neu verbinden und „Anzeigen verwalten“ erlauben');
  problems.errors.push(...linkError, ...[...new Set(missing)]);
  const account = spec.platform === 'meta' ? meta_.adAccountId : String(conn?.config.customer_id ?? '');
  return { conn, spec, link, currency, accountName, pageName: String(conn?.config.page_name ?? ''), audiences, excluded, audienceNames, leadForm: lf, mediaNames, problems, hash: reviewHash(spec, `${spec.platform}:${account}`) };
}

export function review(app: App, locationId: string, spec: AdSpec): Review {
  const p = prepare(app, locationId, spec);
  return reviewOf(p.spec, { accountName: p.accountName, currency: p.currency, problems: p.problems, link: p.link, mediaNames: p.mediaNames, audienceNames: p.audienceNames, leadFormName: p.leadForm?.name, hash: p.hash });
}

// --- publishing ------------------------------------------------------------------------------------------------------

const sleep = (app: App) => (ms: number): Promise<void> => (app.services.adsSleep ? app.services.adsSleep(ms) : new Promise((r) => setTimeout(r, ms)));

function metaMedia(app: App, locationId: string, spec: AdSpec) {
  const images: { u: Upload; role?: string }[] = [];
  const videos: Upload[] = [];
  for (const m of spec.creative.media ?? []) {
    const u = uploadOf(app, locationId, m.upload_id);
    if (!u) continue;
    if (/^video\//.test(u.mime)) videos.push(u);
    else if (/^image\/(png|jpeg|gif|webp)$/.test(u.mime)) images.push({ u, role: m.role });
  }
  const out: { image?: meta.MediaFile; video?: meta.MediaFile; thumbnail?: meta.MediaFile } = {};
  if (videos.length) {
    const base = app.baseUrl();
    if (!/^https:\/\//.test(base) || /localhost|127\.0\.0\.1/.test(base)) throw bad('Ein Video holt Meta über eine öffentliche https-Adresse ab – setze PGHL_BASE_URL auf die öffentliche Adresse oder nimm ein Bild');
    out.video = { kind: 'video', url: `${base}/uploads/${videos[0].file}`, name: videos[0].name };
    const thumb = images.find((i) => i.role === 'thumbnail') ?? images[0];
    if (!thumb) throw bad('Für ein Video brauchst du zusätzlich ein Vorschaubild');
    out.thumbnail = { kind: 'image', base64: readUpload(app, thumb.u).toString('base64'), name: thumb.u.name, thumbnail: true };
  } else {
    const first = images.find((i) => i.role !== 'thumbnail') ?? images[0];
    if (!first) throw bad('Bild oder Video fehlt');
    out.image = { kind: 'image', base64: readUpload(app, first.u).toString('base64'), name: first.u.name };
  }
  return out;
}

/** Creates the campaign at the platform – PAUSED – bound to the version the person reviewed. */
export async function publish(app: App, ctx: Ctx | undefined, row: CampaignRow, expectHash: string | undefined, o: { actor?: string } = {}): Promise<CampaignRow> {
  if (row.status !== 'draft' && row.status !== 'error') throw new HttpError(409, row.status === 'publishing' ? 'Die Kampagne wird gerade angelegt' : 'Die Kampagne ist schon angelegt');
  const p = prepare(app, row.location_id, row.spec);
  if (p.problems.errors.length) throw bad(`Noch nicht bereit: ${p.problems.errors.slice(0, 3).join(' · ')}`);
  if (!expectHash) throw bad('Bitte zuerst die Prüfung ansehen (review_hash fehlt)');
  if (expectHash !== p.hash) throw new HttpError(409, 'Die Kampagne wurde seit der Prüfung geändert – bitte noch einmal prüfen');
  const claimed = app.db.run(`UPDATE ads_campaigns SET status = 'publishing', last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('draft', 'error')`, now(), row.id).changes;
  if (!claimed) throw new HttpError(409, 'Die Kampagne wird gerade angelegt');
  const spec = p.spec;
  try {
    let remote: Record<string, any>;
    let remoteId: string;
    if (spec.platform === 'meta') {
      const c = metaCreds(p.conn);
      const api = meta.metaApi(fetcherOf(app), c.version, c.token);
      const tr = tracking(spec, p.link);
      const published = await meta.publishMeta(
        api,
        c.adAccountId,
        spec,
        { pageId: c.pageId, pageName: p.pageName, pixelId: c.pixelId, accountName: p.accountName, currency: p.currency, divisor: currencyDivisor(p.currency), link: p.link, urlTags: tr.urlTags, audiences: p.audiences, excluded: p.excluded, leadFormId: p.leadForm?.form_id },
        metaMedia(app, row.location_id, spec),
        sleep(app),
      );
      remote = published as unknown as Record<string, any>;
      remoteId = published.campaign_id;
    } else {
      const auth = await googleAuth(app, p.conn);
      const api = google.googleApi(fetcherOf(app), auth);
      const tr = tracking(spec, p.link);
      const images: { role: 'marketing' | 'square' | 'logo'; data: string; name: string }[] = [];
      if (spec.kind === 'pmax') {
        for (const m of spec.creative.media ?? []) {
          const u = uploadOf(app, row.location_id, m.upload_id);
          if (u && (m.role === 'marketing' || m.role === 'square' || m.role === 'logo') && /^image\/(png|jpeg|gif)$/.test(u.mime)) images.push({ role: m.role, data: readUpload(app, u).toString('base64'), name: u.name });
        }
      }
      const gctx = { customerId: auth.customerId, finalUrl: p.link, trackingTemplate: tr.trackingTemplate, userLists: p.audiences, images, tag: Date.now().toString(36) };
      const published = await google.publishGoogle(api, spec.kind === 'pmax' ? google.pmaxMutate(spec, gctx) : google.searchMutate(spec, gctx));
      remote = published as unknown as Record<string, any>;
      remoteId = published.campaign_id;
    }
    app.db.run(`UPDATE ads_campaigns SET status = 'paused', remote = ?, remote_id = ?, currency = ?, published_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`, JSON.stringify(remote), remoteId, p.currency, now(), now(), row.id);
    cacheRemote(app, row.location_id, spec.platform, { id: remoteId, name: spec.name, status: 'paused', raw_status: 'PAUSED', objective: spec.goal, budget_cents: spec.budget.amount_cents, budget_type: spec.budget.type });
    const summary = `Kampagne „${spec.name}“ bei ${PLATFORM_LABEL[spec.platform]} pausiert angelegt (${spec.budget.type === 'daily' ? 'Tagesbudget' : 'Gesamtbudget'} ${(spec.budget.amount_cents / 100).toLocaleString('de-DE', { style: 'currency', currency: p.currency })})`;
    audit(app, ctx, 'ads.campaign.publish', summary, { locationId: row.location_id, entityId: row.id, actor: o.actor });
    activity(app, row.location_id, { campaignId: row.id, platform: spec.platform, remoteId, kind: 'published', summary, actor: o.actor ?? ctx?.user?.name, via: ctx?.via });
    return getCampaign(app, row.location_id, row.id)!;
  } catch (e) {
    const msg = (e as Error).message;
    app.db.run(`UPDATE ads_campaigns SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?`, msg.slice(0, 500), now(), row.id);
    activity(app, row.location_id, { campaignId: row.id, platform: spec.platform, kind: 'error', summary: `Anlegen fehlgeschlagen: ${msg}`, actor: o.actor ?? ctx?.user?.name, via: ctx?.via });
    if (e instanceof HttpError) throw e;
    throw new HttpError(e instanceof AdsError || (e as any)?.status ? 502 : 500, msg);
  }
}

// --- remote cache -----------------------------------------------------------------------------------------------------

export function cacheRemote(app: App, locationId: string, platform: Platform, c: meta.RemoteCampaign) {
  app.db.run(
    `INSERT INTO ads_remote (location_id, platform, campaign_id, name, status, raw_status, objective, budget_cents, budget_type, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, platform, campaign_id) DO UPDATE SET name = excluded.name, status = excluded.status, raw_status = excluded.raw_status, objective = excluded.objective,
       budget_cents = COALESCE(excluded.budget_cents, ads_remote.budget_cents), budget_type = COALESCE(excluded.budget_type, ads_remote.budget_type), updated_at = excluded.updated_at`,
    locationId, platform, c.id, c.name, c.status, c.raw_status, c.objective, c.budget_cents, c.budget_type, now(),
  );
}

/** Reads the campaigns of the connected ad account and keeps the local copy (and HyperLevel's own campaign status) in step. */
export async function refreshRemote(app: App, locationId: string, platform: Platform): Promise<number> {
  const conn = loadConnection(app, locationId, platform);
  if (!connected(app, platform, conn)) throw bad(`${PLATFORM_LABEL[platform]} ist nicht verbunden`);
  try {
    let list: meta.RemoteCampaign[];
    if (platform === 'meta') {
      const c = metaCreds(conn);
      list = await meta.listCampaigns(meta.metaApi(fetcherOf(app), c.version, c.token), c.adAccountId, currencyDivisor(String(conn!.config.currency || 'EUR')));
    } else {
      list = await google.listCampaigns(google.googleApi(fetcherOf(app), await googleAuth(app, conn)));
    }
    app.db.tx(() => {
      for (const c of list) cacheRemote(app, locationId, platform, c);
      const keep = new Set(list.map((c) => c.id));
      for (const r of app.db.all<{ campaign_id: string }>('SELECT campaign_id FROM ads_remote WHERE location_id = ? AND platform = ?', locationId, platform)) {
        if (!keep.has(r.campaign_id)) app.db.run('DELETE FROM ads_remote WHERE location_id = ? AND platform = ? AND campaign_id = ?', locationId, platform, r.campaign_id);
      }
      for (const c of list) {
        const st = c.status === 'active' ? 'active' : c.status === 'paused' ? 'paused' : null;
        if (st) app.db.run(`UPDATE ads_campaigns SET status = ?, updated_at = ? WHERE location_id = ? AND platform = ? AND remote_id = ? AND status IN ('paused', 'active') AND status != ?`, st, now(), locationId, platform, c.id, st);
      }
    });
    setConnectionError(app, locationId, platform, null);
    return list.length;
  } catch (e) {
    const msg = (e as Error).message;
    setConnectionError(app, locationId, platform, msg);
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, msg);
  }
}

// --- status & budget -----------------------------------------------------------------------------------------------

const eur = (cents: number, cur = 'EUR') => (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: cur });

function managed(app: App, locationId: string, platform: Platform): Connection {
  const conn = loadConnection(app, locationId, platform);
  if (!connected(app, platform, conn)) throw bad(`${PLATFORM_LABEL[platform]} ist nicht verbunden`);
  if (!canManage(platform, conn)) throw bad('Der Zugang darf nur lesen – bitte neu verbinden und „Anzeigen verwalten“ erlauben');
  return conn!;
}

const nameOf = (app: App, locationId: string, platform: Platform, remoteId: string): string =>
  app.db.get<{ name: string }>('SELECT name FROM ads_remote WHERE location_id = ? AND platform = ? AND campaign_id = ?', locationId, platform, remoteId)?.name ??
  app.db.get<{ name: string }>('SELECT name FROM ads_campaigns WHERE location_id = ? AND platform = ? AND remote_id = ?', locationId, platform, remoteId)?.name ??
  remoteId;

/** The local record behind a platform campaign, if HyperLevel created it. */
export const localOf = (app: App, locationId: string, platform: Platform, remoteId: string): CampaignRow | undefined => {
  const row = app.db.get('SELECT * FROM ads_campaigns WHERE location_id = ? AND platform = ? AND remote_id = ?', locationId, platform, remoteId);
  return row ? (parseJson(row, ['spec', 'remote']) as CampaignRow) : undefined;
};

/** Switches a campaign on or off at the platform. No confirmation here – callers go through `spend` for "active". */
export async function applyStatus(app: App, ctx: Ctx | undefined, o: { locationId: string; platform: Platform; remoteId: string; status: 'active' | 'paused'; actor?: string; why?: string }): Promise<void> {
  const remoteId = checkRemoteId(o.remoteId);
  const conn = managed(app, o.locationId, o.platform);
  const local = localOf(app, o.locationId, o.platform, remoteId);
  const name = nameOf(app, o.locationId, o.platform, remoteId);
  await relay(async () => {
    if (o.platform === 'meta') {
      const c = metaCreds(conn);
      const api = meta.metaApi(fetcherOf(app), c.version, c.token);
      const st = o.status === 'active' ? 'ACTIVE' : 'PAUSED';
      await meta.setStatus(api, remoteId, st);
      // What HyperLevel created below the campaign was created paused: switching on means switching on all three levels.
      if (o.status === 'active' && local?.remote.adset_id) await meta.setStatus(api, String(local.remote.adset_id), 'ACTIVE');
      if (o.status === 'active' && local?.remote.ad_id) await meta.setStatus(api, String(local.remote.ad_id), 'ACTIVE');
    } else {
      const auth = await googleAuth(app, conn);
      const api = google.googleApi(fetcherOf(app), auth);
      const ids = { campaign: String(local?.remote.campaign || `customers/${auth.customerId}/campaigns/${remoteId}`), ad_group: local?.remote.ad_group, ad_group_ad: local?.remote.ad_group_ad, asset_group: local?.remote.asset_group };
      await google.setStatus(api, ids, o.status === 'active' ? 'ENABLED' : 'PAUSED');
    }
  });
  app.db.run('UPDATE ads_remote SET status = ?, raw_status = ?, updated_at = ? WHERE location_id = ? AND platform = ? AND campaign_id = ?', o.status, o.status === 'active' ? 'ACTIVE' : 'PAUSED', now(), o.locationId, o.platform, remoteId);
  app.db.run(`UPDATE ads_campaigns SET status = ?, updated_at = ? WHERE location_id = ? AND platform = ? AND remote_id = ? AND status IN ('paused', 'active')`, o.status, now(), o.locationId, o.platform, remoteId);
  const summary = `„${name}“ bei ${PLATFORM_LABEL[o.platform]} ${o.status === 'active' ? 'aktiviert' : 'pausiert'}${o.why ? ` (${o.why})` : ''}`;
  audit(app, ctx, o.status === 'active' ? 'ads.campaign.activate' : 'ads.campaign.pause', summary, { locationId: o.locationId, entityId: local?.id ?? remoteId, actor: o.actor });
  activity(app, o.locationId, { campaignId: local?.id, platform: o.platform, remoteId, kind: o.status === 'active' ? 'activated' : 'paused', summary, actor: o.actor ?? ctx?.user?.name, via: ctx?.via });
  app.events.emit(o.locationId, o.status === 'active' ? 'ads.campaign_activated' : 'ads.campaign_paused', { platform: o.platform, campaignId: remoteId, name });
}

/** Changes the budget at the platform (Meta: ad set or campaign budget, Google: the campaign's own budget). */
export async function applyBudget(app: App, ctx: Ctx | undefined, o: { locationId: string; platform: Platform; remoteId: string; type?: 'daily' | 'lifetime'; amountCents: number; actor?: string }): Promise<{ from_cents: number | null; to_cents: number }> {
  const remoteId = checkRemoteId(o.remoteId);
  const cents = Math.round(o.amountCents);
  if (!(cents > 0)) throw bad('Budget muss größer als 0 sein');
  const max = maxDailyBudget(app, o.locationId);
  if ((o.type ?? 'daily') === 'daily' && cents > max) throw bad(`Das Tagesbudget liegt über dem Limit dieses Sub-Accounts (${eur(max)})`);
  const conn = managed(app, o.locationId, o.platform);
  const local = localOf(app, o.locationId, o.platform, remoteId);
  const name = nameOf(app, o.locationId, o.platform, remoteId);
  const currency = String(conn.config.currency || 'EUR');
  let from: number | null = null;
  await relay(async () => {
    if (o.platform === 'meta') {
      const c = metaCreds(conn);
      const api = meta.metaApi(fetcherOf(app), c.version, c.token);
      const t = await meta.budgetTarget(api, remoteId);
      if (o.type && o.type !== t.type) throw bad(`Meta erlaubt keinen Wechsel zwischen Tages- und Gesamtbudget – diese Kampagne hat ein ${t.type === 'daily' ? 'Tages' : 'Gesamt'}budget`);
      if (t.type === 'lifetime' && cents > max * 30) throw bad(`Das Gesamtbudget liegt über dem Limit dieses Sub-Accounts (${eur(max * 30)})`);
      const div = currencyDivisor(currency);
      from = Math.round((t.amount / div) * 100);
      await meta.setBudget(api, t, Math.round((cents / 100) * div));
    } else {
      const auth = await googleAuth(app, conn);
      const api = google.googleApi(fetcherOf(app), auth);
      const t = await google.budgetTarget(api, remoteId);
      from = Math.round(t.amount / 10_000);
      await google.setBudget(api, t.resource, cents);
    }
  });
  app.db.run('UPDATE ads_remote SET budget_cents = ?, updated_at = ? WHERE location_id = ? AND platform = ? AND campaign_id = ?', cents, now(), o.locationId, o.platform, remoteId);
  if (local) {
    const spec = { ...local.spec, budget: { ...local.spec.budget, amount_cents: cents } };
    app.db.run('UPDATE ads_campaigns SET spec = ?, updated_at = ? WHERE id = ?', JSON.stringify(spec), now(), local.id);
  }
  const summary = `Budget von „${name}“ bei ${PLATFORM_LABEL[o.platform]} geändert: ${from === null ? '?' : eur(from, currency)} → ${eur(cents, currency)}`;
  audit(app, ctx, 'ads.campaign.budget', summary, { locationId: o.locationId, entityId: local?.id ?? remoteId, actor: o.actor });
  activity(app, o.locationId, { campaignId: local?.id, platform: o.platform, remoteId, kind: 'budget', summary, actor: o.actor ?? ctx?.user?.name, via: ctx?.via });
  return { from_cents: from, to_cents: cents };
}

// --- spend changes need a person ---------------------------------------------------------------------------------------

export interface SpendAction {
  locationId: string;
  platform: Platform;
  remoteId: string;
  action: 'activate' | 'budget';
  type?: 'daily' | 'lifetime';
  amountCents?: number;
}

export interface SpendResult {
  status: 'done' | 'approval_required';
  summary: string;
  approval_id?: string;
  message?: string;
  from_cents?: number | null;
  to_cents?: number;
}

const APPROVAL_TTL_MS = 24 * 3600_000;

function describe(app: App, a: SpendAction): string {
  const name = nameOf(app, a.locationId, a.platform, a.remoteId);
  const row = app.db.get<{ budget_cents: number | null; budget_type: string | null }>('SELECT budget_cents, budget_type FROM ads_remote WHERE location_id = ? AND platform = ? AND campaign_id = ?', a.locationId, a.platform, a.remoteId);
  const local = localOf(app, a.locationId, a.platform, a.remoteId);
  const cur = String(loadConnection(app, a.locationId, a.platform)?.config.currency || 'EUR');
  const cents = row?.budget_cents ?? local?.spec.budget?.amount_cents ?? null;
  const type = row?.budget_type ?? local?.spec.budget?.type ?? null;
  const where = PLATFORM_LABEL[a.platform];
  if (a.action === 'activate') return `„${name}“ bei ${where} aktivieren – ab sofort wird Geld ausgegeben${cents ? ` (bis zu ${eur(cents, cur)} ${type === 'lifetime' ? 'insgesamt' : 'pro Tag'})` : ''}`;
  return `Budget von „${name}“ bei ${where}: ${cents ? `${eur(cents, cur)} → ` : 'neu '}${eur(a.amountCents ?? 0, cur)} ${(a.type ?? type) === 'lifetime' ? 'insgesamt' : 'pro Tag'}`;
}

async function execute(app: App, ctx: Ctx | undefined, a: SpendAction, actor?: string): Promise<{ from_cents?: number | null; to_cents?: number }> {
  if (a.action === 'activate') {
    await applyStatus(app, ctx, { locationId: a.locationId, platform: a.platform, remoteId: a.remoteId, status: 'active', actor });
    return {};
  }
  const r = await applyBudget(app, ctx, { locationId: a.locationId, platform: a.platform, remoteId: a.remoteId, type: a.type, amountCents: a.amountCents ?? 0, actor });
  return r;
}

/**
 * Anything that can cost money – switching a campaign on, changing a budget:
 *  - a person in the web or native app has to confirm it (`confirm: true`, after seeing the summary);
 *  - API keys, MCP clients, the HyperLevel Agent and automations never execute it: they leave an approval
 *    that a person decides on under Anzeigen → Freigaben (or in the app).
 */
export async function spend(app: App, ctx: Ctx, a: SpendAction, confirm: boolean): Promise<SpendResult> {
  checkRemoteId(a.remoteId);
  if (a.action === 'budget' && !(Number(a.amountCents) > 0)) throw bad('Budget fehlt');
  if (a.action === 'budget' && (a.type ?? 'daily') === 'daily' && Number(a.amountCents) > maxDailyBudget(app, a.locationId)) throw bad(`Das Tagesbudget liegt über dem Limit dieses Sub-Accounts (${eur(maxDailyBudget(app, a.locationId))})`);
  // Fail early (not connected / read-only) instead of leaving an approval nobody can execute.
  managed(app, a.locationId, a.platform);
  const summary = describe(app, a);
  if (isHuman(ctx)) {
    if (!confirm) throw new HttpError(409, `Bitte bestätigen: ${summary}`);
    const r = await execute(app, ctx, a);
    return { status: 'done', summary, ...r };
  }
  app.db.run(`UPDATE ads_approvals SET status = 'expired' WHERE location_id = ? AND status = 'pending' AND expires_at < ?`, a.locationId, now());
  const payload = JSON.stringify({ type: a.type, amountCents: a.amountCents });
  const dup = app.db.get<{ id: string }>(`SELECT id FROM ads_approvals WHERE location_id = ? AND platform = ? AND remote_id = ? AND action = ? AND payload = ? AND status = 'pending'`, a.locationId, a.platform, a.remoteId, a.action, payload);
  const approvalId = dup?.id ?? id();
  if (!dup) {
    app.db.insert('ads_approvals', {
      id: approvalId,
      location_id: a.locationId,
      platform: a.platform,
      campaign_id: localOf(app, a.locationId, a.platform, a.remoteId)?.id ?? null,
      remote_id: a.remoteId,
      campaign_name: nameOf(app, a.locationId, a.platform, a.remoteId),
      action: a.action,
      payload,
      summary,
      requested_by: ctx.user?.id ?? null,
      requested_by_name: String(ctx.user?.name ?? 'API-Schlüssel').slice(0, 200),
      requested_via: ctx.via ?? '',
      status: 'pending',
      created_at: now(),
      expires_at: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    });
    audit(app, ctx, 'ads.approval.request', `Freigabe angefragt: ${summary}`, { locationId: a.locationId, entityId: approvalId });
    activity(app, a.locationId, { platform: a.platform, remoteId: a.remoteId, kind: 'approval', summary: `Freigabe angefragt: ${summary}`, actor: ctx.user?.name, via: ctx.via });
    app.events.emit(a.locationId, 'ads.approval_requested', { approvalId, summary });
  }
  return { status: 'approval_required', summary, approval_id: approvalId, message: 'Wartet auf Freigabe: Eine Person muss das unter Anzeigen → Freigaben bestätigen. Es wurde noch nichts geändert und kein Geld ausgegeben.' };
}

/** A person decides on an approval. Only logins in the web/native app (never keys, MCP or the agent) may approve. */
export async function decide(app: App, ctx: Ctx, locationId: string, approvalId: string, approve: boolean): Promise<{ status: string; summary: string; error?: string }> {
  if (!isHuman(ctx)) throw new HttpError(403, 'Freigaben kann nur eine Person in der Oberfläche entscheiden');
  const row = app.db.get('SELECT * FROM ads_approvals WHERE id = ? AND location_id = ?', approvalId, locationId);
  if (!row) throw notFound('Freigabe nicht gefunden');
  if (row.status !== 'pending') throw new HttpError(409, 'Diese Freigabe ist schon entschieden');
  const who = String(ctx.user?.name ?? '').slice(0, 200);
  if (row.expires_at < now()) {
    app.db.run(`UPDATE ads_approvals SET status = 'expired' WHERE id = ?`, row.id);
    throw new HttpError(409, 'Die Freigabe ist abgelaufen – bitte neu anfragen');
  }
  // Claim it first, so a second click (or a second person) cannot run it twice.
  const claimed = app.db.run(`UPDATE ads_approvals SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ? WHERE id = ? AND status = 'pending'`, approve ? 'approved' : 'rejected', ctx.user?.id ?? null, who, now(), row.id).changes;
  if (!claimed) throw new HttpError(409, 'Diese Freigabe ist schon entschieden');
  if (!approve) {
    audit(app, ctx, 'ads.approval.reject', `Freigabe abgelehnt: ${row.summary}`, { locationId, entityId: row.id });
    activity(app, locationId, { campaignId: row.campaign_id, platform: row.platform, remoteId: row.remote_id, kind: 'approval', summary: `Freigabe abgelehnt: ${row.summary}`, actor: who, via: ctx.via });
    return { status: 'rejected', summary: row.summary };
  }
  const p = JSON.parse(row.payload || '{}');
  try {
    await execute(app, ctx, { locationId, platform: row.platform, remoteId: row.remote_id, action: row.action, type: p.type, amountCents: p.amountCents }, who);
    audit(app, ctx, 'ads.approval.approve', `Freigegeben (angefragt über ${row.requested_via || 'API'} von ${row.requested_by_name}): ${row.summary}`, { locationId, entityId: row.id });
    return { status: 'approved', summary: row.summary };
  } catch (e) {
    const msg = (e as Error).message;
    app.db.run(`UPDATE ads_approvals SET status = 'failed', result = ? WHERE id = ?`, msg.slice(0, 500), row.id);
    audit(app, ctx, 'ads.approval.failed', `Freigabe fehlgeschlagen: ${row.summary} – ${msg}`, { locationId, entityId: row.id });
    throw e;
  }
}
