import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, type Ctx, type RawResult } from '../core/http.js';
import { now, safeEqual, sha256, token } from '../core/util.js';
import { logActivity, upsertContact } from '../services/contacts.js';
import type { Tool } from './mcp.js';

/**
 * Google-Lead-Formulare als Lead-Quelle – docs/ads-manager.md#google-lead-forms. Google Ads lead form assets deliver each lead to a
 * webhook URL with a key you choose ("google_key"). HyperLevel gives every sub-account its own URL and key; a lead becomes a
 * contact (tagged, the form's answers as custom fields, attribution `google / cpc`) and fires the same trigger as Meta leads
 * („Neuer Lead aus Anzeige“, `ads.lead` with `platform: 'Google'`). Test leads from the Google Ads "Send test data" button are
 * imported with the tag `test-lead`. Only the hash of the key is stored; a lead id is imported once.
 */

const DEFAULT_TAGS = ['google-lead'];
/** Google's standard column ids → contact fields. */
const COLUMNS: Record<string, string> = {
  FULL_NAME: 'name',
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  EMAIL: 'email',
  WORK_EMAIL: 'email',
  PHONE_NUMBER: 'phone',
  WORK_PHONE: 'phone',
  COMPANY_NAME: 'company',
  CITY: 'city',
  POSTAL_CODE: 'postal_code',
  STREET_ADDRESS: 'address',
  COUNTRY: 'country',
};

/** A Google lead payload → contact input + custom answers. */
export function mapGoogleLead(body: any): { input: Record<string, string>; custom: Record<string, string> } {
  const input: Record<string, string> = {};
  const custom: Record<string, string> = {};
  for (const c of Array.isArray(body?.user_column_data) ? body.user_column_data.slice(0, 60) : []) {
    const id = String(c?.column_id ?? '').toUpperCase();
    const value = String(c?.string_value ?? '').trim().slice(0, 500);
    if (!value) continue;
    const field = COLUMNS[id];
    if (field && !input[field]) input[field] = value;
    else {
      const key = String(c?.column_name || id || 'antwort').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'antwort';
      custom[key] = value;
    }
  }
  return { input, custom };
}

export const adsGoogleLeadsModule: Module = {
  name: 'ads-google-leads',
  migrations: [
    [
      '001-init',
      `CREATE TABLE google_lead_hooks (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_lead_at TEXT
      );
      CREATE TABLE google_leads (
        lead_id TEXT NOT NULL, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, contact_id TEXT,
        form_id TEXT NOT NULL DEFAULT '', campaign_id TEXT NOT NULL DEFAULT '', gclid TEXT NOT NULL DEFAULT '', is_test INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, PRIMARY KEY (location_id, lead_id)
      );
      CREATE INDEX google_leads_loc ON google_leads(location_id, created_at);`,
    ],
  ],
  register(app: App) {
    const { db, router } = app;
    const hookOf = (loc: string) => parseJson(db.get<any>('SELECT * FROM google_lead_hooks WHERE location_id = ?', loc), ['tags']);
    const urlOf = (loc: string) => `${app.baseUrl()}/hooks/ads/google-leads/${encodeURIComponent(loc)}`;
    const status = (loc: string) => {
      const h = hookOf(loc);
      return {
        enabled: !!h?.enabled,
        url: urlOf(loc),
        tags: h?.tags?.length ? h.tags : DEFAULT_TAGS,
        last_lead_at: h?.last_lead_at ?? null,
        recent: db.all('SELECT g.lead_id, g.contact_id, g.form_id, g.campaign_id, g.is_test, g.created_at, c.first_name, c.last_name, c.email FROM google_leads g LEFT JOIN contacts c ON c.id = g.contact_id WHERE g.location_id = ? ORDER BY g.created_at DESC LIMIT 20', loc),
      };
    };

    router.get('/api/ads/google-leads', 'location', (ctx) => status(ctx.locationId));
    /** Switches the source on and hands out a new key – shown once, to paste into Google Ads next to the URL. */
    router.post('/api/ads/google-leads/enable', 'location', (ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
      const key = token(18);
      const tags = Array.isArray(ctx.body?.tags) ? ctx.body.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 10) : DEFAULT_TAGS;
      db.run(
        `INSERT INTO google_lead_hooks (location_id, key_hash, tags, enabled, created_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(location_id) DO UPDATE SET key_hash = excluded.key_hash, tags = excluded.tags, enabled = 1`,
        ctx.locationId, sha256(key), JSON.stringify(tags), now(),
      );
      return { ...status(ctx.locationId), key };
    });
    router.post('/api/ads/google-leads/disable', 'location', (ctx) => {
      db.run('UPDATE google_lead_hooks SET enabled = 0 WHERE location_id = ?', ctx.locationId);
      return status(ctx.locationId);
    });

    const reply = (body: unknown, status = 200): RawResult => ({ __raw: true, status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, body: JSON.stringify(body) });
    router.post('/hooks/ads/google-leads/:location', 'public', (ctx: Ctx) => {
      const loc = ctx.params.location;
      const h = hookOf(loc);
      if (!h?.enabled || !safeEqual(h.key_hash, sha256(String(ctx.body?.google_key ?? '')))) return reply({ error: 'unauthorized' }, 401);
      const leadId = String(ctx.body?.lead_id ?? '').slice(0, 200);
      if (!leadId) return reply({ error: 'lead_id missing' }, 400);
      if (db.get('SELECT 1 FROM google_leads WHERE location_id = ? AND lead_id = ?', loc, leadId)) return reply({});
      const test = ctx.body?.is_test === true;
      const { input, custom } = mapGoogleLead(ctx.body);
      if (!input.email && !input.phone && !input.name && !input.first_name) return reply({ error: 'no contact data' }, 400);
      const tags = [...(h.tags?.length ? h.tags : DEFAULT_TAGS), ...(test ? ['test-lead'] : [])];
      const { contact, created } = upsertContact(app, loc, { ...input, custom }, { source: 'Google Lead-Formular', tags, publicInput: true });
      db.run(
        'INSERT INTO google_leads (lead_id, location_id, contact_id, form_id, campaign_id, gclid, is_test, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        leadId, loc, contact.id, String(ctx.body?.form_id ?? '').slice(0, 60), String(ctx.body?.campaign_id ?? '').slice(0, 60), String(ctx.body?.gcl_id ?? '').slice(0, 200), test ? 1 : 0, now(),
      );
      db.run('UPDATE google_lead_hooks SET last_lead_at = ? WHERE location_id = ?', now(), loc);
      logActivity(app, loc, contact.id, 'ads.lead', `Lead aus Google-Lead-Formular${test ? ' (Test)' : ''}`, { lead_id: leadId, form_id: ctx.body?.form_id, campaign_id: ctx.body?.campaign_id });
      try {
        app.services.attribution?.capture(undefined, loc, contact.id, 'lead_ad', { params: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: String(ctx.body?.campaign_id ?? ''), gclid: String(ctx.body?.gcl_id ?? '') } });
      } catch {
        /* attribution is optional */
      }
      app.events.emit(loc, 'ads.lead', { contactId: contact.id, contact, created, leadgenId: leadId, platform: 'Google', formId: String(ctx.body?.form_id ?? ''), formName: '', campaignId: String(ctx.body?.campaign_id ?? ''), campaignName: '', adId: '', adName: '', adsetName: '', organic: false, test });
      return reply({});
    });

    const TOOLS: Tool[] = [
      {
        name: 'ghl_google_lead_forms',
        title: 'Google-Lead-Formulare: Status und letzte Leads',
        description: 'Zeigt, ob Google-Ads-Lead-Formulare als Lead-Quelle verbunden sind (Webhook-URL, Tags) und die letzten 20 importierten Leads.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        untrusted: true,
        run: (call, a) => call.api('GET', '/api/ads/google-leads', { location: a.location_id }),
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
