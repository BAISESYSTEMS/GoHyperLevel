import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { DEFAULT_LEAD_TAGS, handleLeadgen, leadSettings, pollLeads, signedBy } from '../services/ads-leads.js';
import { STANDARD_QUESTIONS, createLeadForm, metaApi, subscribeLeadgen, type LeadFormSpec, type LeadQuestion } from '../services/ads-meta.js';
import { activity, agencyAds, audit, fetcherOf, loadConnection, metaCreds, relay, saveConnection } from '../services/ads-store.js';
import { sameSecret } from '../services/meta.js';

/**
 * Meta Lead Ads: instant forms created from HyperLevel, and the lead import – webhook (`leadgen`, X-Hub-Signature-256)
 * with a polling fallback. A lead becomes a contact (tagged, with its answers) and starts workflows
 * (trigger „Neuer Lead aus Anzeige“). See services/ads-leads.ts for the mapping.
 */

const POLL_EVERY_MS = 10 * 60_000;
const LEAD_TRIGGER = 'ads.lead';

const cleanQuestions = (v: unknown): LeadQuestion[] => {
  const out: LeadQuestion[] = [];
  for (const q of Array.isArray(v) ? v : []) {
    if (typeof q === 'string') {
      const t = q.trim().toUpperCase();
      if (STANDARD_QUESTIONS.includes(t) && !out.includes(t)) out.push(t);
    } else if (q && typeof q === 'object') {
      const label = String((q as any).label ?? '').trim().slice(0, 120);
      const key = String((q as any).key ?? label).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
      if (label && key) out.push({ type: 'CUSTOM', key, label });
    }
  }
  return out.slice(0, 15);
};

export const adsLeadsModule: Module = {
  name: 'ads-leads',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_leadforms (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, page_id TEXT NOT NULL, form_id TEXT NOT NULL DEFAULT '', spec TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'ready', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ads_leadforms_loc ON ads_leadforms(location_id, created_at);
      CREATE TABLE ads_leads (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, leadgen_id TEXT NOT NULL,
        page_id TEXT NOT NULL DEFAULT '', form_id TEXT NOT NULL DEFAULT '', ad_id TEXT NOT NULL DEFAULT '',
        campaign_id TEXT NOT NULL DEFAULT '', campaign_name TEXT NOT NULL DEFAULT '', contact_id TEXT,
        status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'webhook', created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, leadgen_id)
      );
      CREATE INDEX ads_leads_loc ON ads_leads(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = () => fetcherOf(app);

    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), LEAD_TRIGGER];
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      [LEAD_TRIGGER]: (c: any, d: any) => (!c.form_id || c.form_id === d.formId) && (!c.campaign_id || c.campaign_id === d.campaignId) && (!c.platform || c.platform === d.platform),
    };

    // --- webhook ---------------------------------------------------------------------------------------------
    // One address for the whole Meta app (Webhooks → Page → leadgen). The verify token is the agency's.
    router.get('/hooks/ads/meta', 'public', (ctx) => {
      const want = agencyAds(app).meta.verify_token;
      const challenge = ctx.query.get('hub.challenge') ?? '';
      if (!want || ctx.query.get('hub.mode') !== 'subscribe' || !sameSecret(ctx.query.get('hub.verify_token') ?? '', want)) throw new HttpError(403, 'Verify-Token stimmt nicht');
      if (!/^[\w.-]{1,200}$/.test(challenge)) throw bad('hub.challenge fehlt');
      return text(challenge);
    });

    router.post('/hooks/ads/meta', 'public', async (ctx: Ctx) => {
      // The signature covers the exact bytes Meta sent; without a matching app secret nothing is read.
      const secret = signedBy(app, ctx.rawBody, ctx.req.headers['x-hub-signature-256']);
      if (!secret) throw new HttpError(401, 'Signatur ungültig');
      const r = await handleLeadgen(app, ctx.body, secret);
      return { ok: true, ...r };
    });

    // The Messenger/WhatsApp webhook of the same Meta app (modules/meta-channels.ts) may receive `leadgen` too:
    // an app has one callback address per object, so both kinds of events can arrive there.
    app.services.metaWebhookHooks = [
      ...(app.services.metaWebhookHooks ?? []),
      async (e: { payload: any; secret: string }) => {
        await handleLeadgen(app, e.payload, e.secret);
      },
    ];

    // --- settings & status ---------------------------------------------------------------------------------
    const status = (locationId: string) => {
      const conn = loadConnection(app, locationId, 'meta');
      const c = metaCreds(conn);
      const s = leadSettings(conn);
      const scopes: string[] = Array.isArray(conn?.config.scopes) ? conn!.config.scopes : [];
      return {
        enabled: s.enabled,
        tags: s.tags,
        page: c.pageId ? { id: c.pageId, name: conn?.config.page_name ?? '' } : null,
        page_token: !!c.pageToken,
        scope_ok: scopes.includes('leads_retrieval') || conn?.config.connected_via !== 'oauth',
        enabled_at: s.enabled_at ?? null,
        polled_at: s.polled_at ?? null,
        subscribed: conn?.config.leads?.subscribed ?? null,
        webhook_url: `${app.baseUrl()}/hooks/ads/meta`,
        verify_token: agencyAds(app).meta.verify_token,
        counts: db.get('SELECT COUNT(*) AS total, SUM(status = \'imported\') AS imported, SUM(status = \'failed\') AS failed FROM ads_leads WHERE location_id = ?', locationId),
      };
    };
    router.get('/api/ads/leads/status', 'location', (ctx) => status(ctx.locationId));
    router.get('/api/ads/leads', 'location', (ctx) =>
      db.all(
        `SELECT l.*, c.first_name, c.last_name, c.email FROM ads_leads l LEFT JOIN contacts c ON c.id = l.contact_id AND c.location_id = l.location_id WHERE l.location_id = ? ORDER BY l.created_at DESC LIMIT 100`,
        ctx.locationId,
      ),
    );

    router.post('/api/ads/leads/enable', 'location', async (ctx) => {
      const conn = loadConnection(app, ctx.locationId, 'meta');
      const c = metaCreds(conn);
      if (!c.token) throw bad('Meta ist noch nicht verbunden');
      if (!c.pageId || !c.pageToken) throw bad('Bitte zuerst eine Facebook-Seite wählen (Anzeigen → Verbindungen) – mit der Option „Lead-Formulare“ verbinden');
      const tags = Array.isArray(ctx.body?.tags) ? [...new Set<string>(ctx.body.tags.map((t: unknown) => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, 10) : leadSettings(conn).tags;
      // The Page has to send `leadgen` to the app – keeping what it already gets (messages …).
      let fields: string[] | null = null;
      let warn = '';
      try {
        fields = await subscribeLeadgen(metaApi(fetcher(), c.version, c.pageToken), c.pageId, agencyAds(app).meta.app_id || undefined);
      } catch (e) {
        warn = `Webhook-Abo bei Meta nicht gesetzt (${(e as Error).message}) – die Leads werden trotzdem alle 10 Minuten abgeholt`;
      }
      saveConnection(app, ctx.locationId, 'meta', { config: { leads: { ...(conn!.config.leads ?? {}), enabled: true, enabled_at: conn!.config.leads?.enabled_at ?? now(), tags: tags.length ? tags : DEFAULT_LEAD_TAGS, subscribed: fields } } });
      audit(app, ctx, 'ads.leads.enable', `Lead-Import für die Seite „${conn!.config.page_name ?? c.pageId}“ eingeschaltet`, { locationId: ctx.locationId });
      return { ...status(ctx.locationId), warning: warn || undefined };
    });

    router.post('/api/ads/leads/disable', 'location', (ctx) => {
      const conn = loadConnection(app, ctx.locationId, 'meta');
      if (!conn) return status(ctx.locationId);
      saveConnection(app, ctx.locationId, 'meta', { config: { leads: { ...(conn.config.leads ?? {}), enabled: false } } });
      audit(app, ctx, 'ads.leads.disable', 'Lead-Import ausgeschaltet', { locationId: ctx.locationId });
      return status(ctx.locationId);
    });

    router.put('/api/ads/leads/settings', 'location', (ctx) => {
      const conn = loadConnection(app, ctx.locationId, 'meta');
      if (!conn) throw bad('Meta ist noch nicht verbunden');
      const tags = [...new Set<string>((Array.isArray(ctx.body?.tags) ? ctx.body.tags : []).map((t: unknown) => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, 10);
      saveConnection(app, ctx.locationId, 'meta', { config: { leads: { ...(conn.config.leads ?? {}), tags: tags.length ? tags : DEFAULT_LEAD_TAGS } } });
      return status(ctx.locationId);
    });

    router.post('/api/ads/leads/poll', 'location', async (ctx) => {
      if (!leadSettings(loadConnection(app, ctx.locationId, 'meta')).enabled) throw bad('Der Lead-Import ist ausgeschaltet');
      return relay(() => pollLeads(app, ctx.locationId));
    });

    // The fallback: every ten minutes, per sub-account with lead import on.
    let running = false;
    app.onTick(async () => {
      if (running) return;
      running = true;
      try {
        for (const r of db.all<{ location_id: string }>(`SELECT location_id FROM ads_accounts WHERE platform = 'meta' AND json_extract(config, '$.leads.enabled') = 1`)) {
          const s = leadSettings(loadConnection(app, r.location_id, 'meta'));
          if (s.polled_at && Date.now() - Date.parse(s.polled_at) < POLL_EVERY_MS) continue;
          await pollLeads(app, r.location_id).catch((e) => console.warn('[ads] lead poll', r.location_id, (e as Error).message));
        }
      } finally {
        running = false;
      }
    });

    // --- instant forms ----------------------------------------------------------------------------------------------
    const formOut = (f: any) => ({ ...parseJson({ ...f }, ['spec']) });
    router.get('/api/ads/leadforms', 'location', (ctx) => db.all('SELECT * FROM ads_leadforms WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId).map(formOut));

    router.post('/api/ads/leadforms', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const conn = loadConnection(app, ctx.locationId, 'meta');
      const c = metaCreds(conn);
      if (!c.pageId || !c.pageToken) throw bad('Für Sofortformulare braucht es eine Facebook-Seite – unter Anzeigen → Verbindungen mit der Option „Lead-Formulare“ verbinden');
      const name = str(b.name, 'Name', { required: true, max: 200 });
      const questions = cleanQuestions(b.questions);
      if (!questions.some((q) => q === 'EMAIL' || q === 'PHONE' || q === 'FULL_NAME' || q === 'FIRST_NAME')) throw bad('Das Formular braucht mindestens E-Mail, Telefon oder Namen');
      const privacy = str(b.privacy_url, 'Datenschutz-Link', { required: true, max: 500 });
      if (!/^https:\/\/\S+$/.test(privacy)) throw bad('Datenschutz-Link: Adresse mit https://');
      const thank = b.thank_you && typeof b.thank_you === 'object' ? b.thank_you : {};
      const thankUrl = str(thank.url, 'Danke-Link', { max: 500 });
      if (thankUrl && !/^https:\/\/\S+$/.test(thankUrl)) throw bad('Danke-Link: Adresse mit https://');
      const spec: LeadFormSpec = {
        name,
        headline: str(b.headline, 'Überschrift', { max: 60 }) || undefined,
        description: str(b.description, 'Beschreibung', { max: 500 }) || undefined,
        questions,
        privacy_url: privacy,
        thank_you: { title: str(thank.title, 'Danke-Titel', { max: 60 }) || 'Danke!', body: str(thank.body, 'Danke-Text', { max: 200 }) || 'Wir melden uns bei dir.', button_text: str(thank.button_text, 'Button', { max: 30 }) || undefined, url: thankUrl || undefined },
      };
      const formId = await relay(() => createLeadForm(metaApi(fetcher(), c.version, c.pageToken), c.pageId, spec));
      const row = { id: id(), location_id: ctx.locationId, name, page_id: c.pageId, form_id: formId, spec: JSON.stringify(spec), status: 'ready', created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      db.insert('ads_leadforms', row);
      audit(app, ctx, 'ads.leadform.create', `Sofortformular „${name}“ bei Meta angelegt (Seite ${conn!.config.page_name ?? c.pageId})`, { locationId: ctx.locationId, entityId: row.id });
      activity(app, ctx.locationId, { platform: 'meta', kind: 'leadform', summary: `Sofortformular „${name}“ angelegt`, actor: ctx.user?.name, via: ctx.via });
      return formOut(row);
    });

    router.delete('/api/ads/leadforms/:id', 'location', async (ctx) => {
      const f = db.get('SELECT * FROM ads_leadforms WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!f) throw notFound('Formular nicht gefunden');
      for (const cmp of db.all<{ name: string; spec: string }>(`SELECT name, spec FROM ads_campaigns WHERE location_id = ? AND status != 'error'`, ctx.locationId)) {
        if (JSON.parse(cmp.spec || '{}').lead_form_id === f.id) throw new HttpError(409, `Das Formular wird von der Kampagne „${cmp.name}“ verwendet`);
      }
      // Meta keeps forms (their leads stay readable): archiving stops new answers.
      const c = metaCreds(loadConnection(app, ctx.locationId, 'meta'));
      if (f.form_id && c.pageToken) await metaApi(fetcher(), c.version, c.pageToken).call('POST', f.form_id, { status: 'ARCHIVED' }).catch(() => undefined);
      db.run('DELETE FROM ads_leadforms WHERE id = ? AND location_id = ?', f.id, ctx.locationId);
      audit(app, ctx, 'ads.leadform.delete', `Sofortformular „${f.name}“ archiviert`, { locationId: ctx.locationId, entityId: f.id });
      return { ok: true };
    });
  },
};

