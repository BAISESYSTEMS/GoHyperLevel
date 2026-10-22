import type { App } from '../core/app.js';
import { id, normalizePhone, now } from '../core/util.js';
import { fetchLead, listFormLeads, metaApi, type MetaApi } from './ads-meta.js';
import { agencyAds, fetcherOf, loadConnection, metaCreds, saveConnection, type Connection } from './ads-store.js';
import { logActivity, upsertContact } from './contacts.js';
import { openSecret } from '../core/secrets.js';
import { verifySignature } from './meta.js';

/**
 * Meta Lead Ads → HyperLevel: a lead (instant form answer) becomes a contact – tagged, with its answers as a note and
 * custom fields, attributed to its campaign/ad – and starts workflows (trigger "Neuer Lead aus Anzeige", plus the
 * usual "Kontakt angelegt" / "Tag hinzugefügt"). Leads arrive by webhook (`leadgen`, signed with X-Hub-Signature-256);
 * the webhook only names the lead – its data is always fetched from the Graph API with the Page's token – and a
 * polling job catches anything the webhook missed.
 */

export interface LeadSettings {
  enabled: boolean;
  enabled_at?: string;
  polled_at?: string;
  tags: string[];
}

export const DEFAULT_LEAD_TAGS = ['meta-lead'];

export function leadSettings(conn: Connection | undefined): LeadSettings {
  const l = conn?.config.leads ?? {};
  return { enabled: !!l.enabled, enabled_at: l.enabled_at, polled_at: l.polled_at, tags: Array.isArray(l.tags) && l.tags.length ? l.tags.map(String) : DEFAULT_LEAD_TAGS };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

export interface MappedLead {
  input: Record<string, any>;
  custom: Record<string, string>;
  answers: { question: string; answer: string }[];
}

/** field_data → contact fields; unknown questions become custom fields (and stay readable in the note). */
export function mapLead(lead: any): MappedLead {
  const input: Record<string, any> = {};
  const custom: Record<string, string> = {};
  const answers: { question: string; answer: string }[] = [];
  for (const f of Array.isArray(lead?.field_data) ? lead.field_data : []) {
    const key = String(f?.name ?? '');
    const value = (Array.isArray(f?.values) ? f.values : [f?.values]).map((v: unknown) => String(v ?? '').trim()).filter(Boolean).join(', ').slice(0, 500);
    if (!key || !value) continue;
    answers.push({ question: key.replace(/_/g, ' '), answer: value });
    switch (key) {
      case 'email':
        input.email = value.toLowerCase();
        break;
      case 'phone_number':
      case 'phone':
        input.phone = normalizePhone(value);
        break;
      case 'full_name':
        input.name = value;
        break;
      case 'first_name':
        input.first_name = value;
        break;
      case 'last_name':
        input.last_name = value;
        break;
      case 'company_name':
        input.company = value;
        break;
      case 'city':
        input.city = value;
        break;
      case 'zip_code':
      case 'post_code':
        input.postal_code = value;
        break;
      case 'street_address':
        input.address = value;
        break;
      case 'country':
        input.country = value;
        break;
      case 'date_of_birth':
        if (/^\d{4}-\d\d-\d\d$/.test(value)) input.date_of_birth = value;
        break;
      case 'job_title':
      case 'state':
      case 'province':
      case 'gender':
      case 'marital_status':
        custom[slug(key)] = value;
        break;
      default:
        if (slug(key)) custom[slug(key)] = value;
    }
  }
  return { input, custom, answers };
}

export interface ImportResult {
  status: 'imported' | 'duplicate' | 'skipped' | 'failed';
  contactId?: string;
  error?: string;
}

interface LeadKey {
  location_id: string;
  leadgen_id: string;
  page_id: string;
  form_id: string;
  ad_id: string;
  campaign_id: string;
  campaign_name: string;
}

/** One row per lead: what became of it (imported, skipped, failed – failed ones are retried by the poll). */
function record(app: App, k: LeadKey, status: 'imported' | 'skipped' | 'failed', o: { contactId?: string; error?: string; source: string }) {
  app.db.run(
    `INSERT INTO ads_leads (location_id, leadgen_id, page_id, form_id, ad_id, campaign_id, campaign_name, contact_id, status, error, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id, leadgen_id) DO UPDATE SET contact_id = COALESCE(excluded.contact_id, contact_id), status = excluded.status, error = excluded.error,
       form_id = CASE WHEN excluded.form_id != '' THEN excluded.form_id ELSE form_id END, campaign_id = CASE WHEN excluded.campaign_id != '' THEN excluded.campaign_id ELSE campaign_id END,
       campaign_name = CASE WHEN excluded.campaign_name != '' THEN excluded.campaign_name ELSE campaign_name END`,
    k.location_id, k.leadgen_id, k.page_id, k.form_id, k.ad_id, k.campaign_id, k.campaign_name, o.contactId ?? null, status, (o.error ?? '').slice(0, 300), o.source, now(),
  );
}

/** Creates or updates the contact of one lead and starts the workflows. Idempotent per lead id. */
export function importLead(app: App, locationId: string, lead: any, source: 'webhook' | 'poll', o: { tags?: string[]; formName?: string } = {}): ImportResult {
  const leadId = String(lead?.id ?? '');
  if (!/^\d{5,30}$/.test(leadId)) return { status: 'skipped', error: 'Lead ohne gültige ID' };
  const seen = app.db.get<{ status: string }>('SELECT status FROM ads_leads WHERE location_id = ? AND leadgen_id = ?', locationId, leadId);
  if (seen?.status === 'imported') return { status: 'duplicate' };
  const key: LeadKey = { location_id: locationId, leadgen_id: leadId, page_id: String(lead.page_id ?? ''), form_id: String(lead.form_id ?? ''), ad_id: String(lead.ad_id ?? ''), campaign_id: String(lead.campaign_id ?? ''), campaign_name: String(lead.campaign_name ?? '').slice(0, 300) };
  const m = mapLead(lead);
  if (!m.input.email && !m.input.phone && !m.input.name && !m.input.first_name && !m.input.last_name) {
    const error = 'Der Lead enthält keine Kontaktdaten';
    record(app, key, 'skipped', { error, source });
    return { status: 'skipped', error };
  }
  const platformName = String(lead.platform ?? '').toLowerCase() === 'ig' ? 'instagram' : 'facebook';
  const organic = lead.is_organic === true || lead.is_organic === 'true';
  try {
    const { contact, created } = upsertContact(app, locationId, { ...m.input, custom: m.custom }, { source: organic ? 'Meta Lead (organisch)' : 'Meta Lead Ad', tags: o.tags ?? DEFAULT_LEAD_TAGS, publicInput: true });
    record(app, key, 'imported', { contactId: contact.id, source });
    const where = [o.formName ? `Formular „${o.formName}“` : '', lead.campaign_name ? `Kampagne „${lead.campaign_name}“` : '', lead.ad_name ? `Anzeige „${lead.ad_name}“` : ''].filter(Boolean).join(', ');
    app.db.insert('notes', {
      id: id(),
      location_id: locationId,
      contact_id: contact.id,
      body: `Meta Lead Ad${where ? ` – ${where}` : ''}\n\n${m.answers.map((a) => `${a.question}: ${a.answer}`).join('\n')}`.slice(0, 4000),
      user_id: null,
      created_at: now(),
    });
    logActivity(app, locationId, contact.id, 'ads.lead', `Lead aus ${organic ? 'Instant-Formular' : 'Anzeige'}${lead.campaign_name ? ` „${lead.campaign_name}“` : ''}`, { leadgen_id: leadId, form_id: key.form_id, campaign_id: key.campaign_id, ad_id: key.ad_id });
    // The campaign (utm_campaign = its name) is what the attribution report and the ad report join on.
    try {
      app.services.attribution?.capture(undefined, locationId, contact.id, 'lead_ad', {
        params: organic ? { utm_source: platformName, utm_medium: 'organic_social' } : { utm_source: platformName, utm_medium: 'paid_social', utm_campaign: lead.campaign_name || lead.campaign_id, utm_content: lead.ad_name || lead.ad_id, utm_term: lead.adset_name || '' },
      });
    } catch (e) {
      console.warn('[ads] attribution', (e as Error).message);
    }
    app.events.emit(locationId, 'ads.lead', {
      contactId: contact.id,
      contact,
      created,
      leadgenId: leadId,
      platform: platformName,
      formId: key.form_id,
      formName: o.formName ?? '',
      campaignId: key.campaign_id,
      campaignName: String(lead.campaign_name ?? ''),
      adId: key.ad_id,
      adName: String(lead.ad_name ?? ''),
      adsetName: String(lead.adset_name ?? ''),
      organic,
      answers: m.answers,
    });
    return { status: 'imported', contactId: contact.id };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    record(app, key, 'failed', { error, source });
    return { status: 'failed', error };
  }
}

// --- webhook ---------------------------------------------------------------------------------------------

/** App secrets a webhook signature may have been made with: the agency's Meta app and each sub-account's own. */
export function knownSecrets(app: App): string[] {
  const out = new Set<string>();
  const a = agencyAds(app).meta.app_secret;
  if (a) out.add(a);
  for (const r of app.db.all<{ app_secret: string }>(`SELECT app_secret FROM meta_accounts WHERE app_secret != ''`)) {
    try {
      out.add(openSecret(app, r.app_secret));
    } catch {
      /* sealed with an older key */
    }
  }
  return [...out];
}

/** Which of the known secrets signed this body, if any. */
export function signedBy(app: App, raw: string | Buffer, header: string | string[] | undefined): string | null {
  for (const s of knownSecrets(app)) if (verifySignature(raw, header, s)) return s;
  return null;
}

/** Secrets a sub-account's leads may be signed with. */
function secretsOf(app: App, locationId: string): string[] {
  const out = new Set<string>();
  const a = agencyAds(app).meta.app_secret;
  if (a) out.add(a);
  const own = app.db.get<{ app_secret: string }>('SELECT app_secret FROM meta_accounts WHERE location_id = ?', locationId)?.app_secret;
  if (own) {
    try {
      out.add(openSecret(app, own));
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export interface LeadgenChange {
  pageId: string;
  leadgenId: string;
  formId: string;
  adId: string;
}

/** The `leadgen` changes of a Page webhook body. */
export function parseLeadgen(payload: any): LeadgenChange[] {
  const out: LeadgenChange[] = [];
  if (payload?.object !== 'page') return out;
  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (ch?.field !== 'leadgen') continue;
      const v = ch.value ?? {};
      const leadgenId = String(v.leadgen_id ?? '');
      if (!/^\d{5,30}$/.test(leadgenId)) continue;
      out.push({ pageId: String(v.page_id ?? entry.id ?? ''), leadgenId, formId: String(v.form_id ?? ''), adId: String(v.ad_id ?? v.adgroup_id ?? '') });
    }
  }
  return out;
}

const formName = (app: App, locationId: string, formId: string) => (formId ? app.db.get<{ name: string }>('SELECT name FROM ads_leadforms WHERE location_id = ? AND form_id = ?', locationId, formId)?.name : undefined);

/**
 * Takes a verified leadgen webhook: each lead goes to the sub-account that owns the Page (and has lead import on),
 * its data is fetched with that sub-account's Page token. `signedWith` is the secret the signature matched – a lead
 * is only delivered to sub-accounts that use that secret, so one app's webhook can never feed another's account.
 */
export async function handleLeadgen(app: App, payload: any, signedWith: string): Promise<{ imported: number; duplicates: number; failed: number; ignored: number }> {
  const res = { imported: 0, duplicates: 0, failed: 0, ignored: 0 };
  for (const ch of parseLeadgen(payload)) {
    const owners = app.db.all<{ location_id: string }>(`SELECT location_id FROM ads_accounts WHERE platform = 'meta' AND json_extract(config, '$.page_id') = ?`, ch.pageId);
    let delivered = false;
    for (const { location_id: loc } of owners) {
      const conn = loadConnection(app, loc, 'meta');
      const s = leadSettings(conn);
      if (!conn || !s.enabled || !secretsOf(app, loc).includes(signedWith)) continue;
      delivered = true;
      const c = metaCreds(conn);
      if (!c.pageToken) {
        res.failed++;
        continue;
      }
      try {
        const lead = await fetchLead(metaApi(fetcherOf(app), c.version, c.pageToken, 20_000), ch.leadgenId);
        const r = importLead(app, loc, { ...lead, page_id: ch.pageId, form_id: lead.form_id ?? ch.formId, ad_id: lead.ad_id ?? ch.adId }, 'webhook', { tags: s.tags, formName: formName(app, loc, String(lead.form_id ?? ch.formId)) });
        if (r.status === 'imported') res.imported++;
        else if (r.status === 'duplicate') res.duplicates++;
        else res.failed++;
      } catch (e) {
        res.failed++;
        // The polling job picks it up again: remember that it is missing.
        app.db.run(
          `INSERT INTO ads_leads (location_id, leadgen_id, page_id, form_id, ad_id, campaign_id, campaign_name, contact_id, status, error, source, created_at) VALUES (?, ?, ?, ?, ?, '', '', NULL, 'failed', ?, 'webhook', ?) ON CONFLICT(location_id, leadgen_id) DO NOTHING`,
          loc, ch.leadgenId, ch.pageId, ch.formId, ch.adId, (e as Error).message.slice(0, 300), now(),
        );
      }
    }
    if (!delivered) res.ignored++;
  }
  return res;
}

// --- polling fallback --------------------------------------------------------------------------------------

/** Leads of the Page's forms since the last poll – covers a webhook that was down or never set up. */
export async function pollLeads(app: App, locationId: string): Promise<{ checked: number; imported: number; failed: number }> {
  const conn = loadConnection(app, locationId, 'meta');
  const s = leadSettings(conn);
  const c = metaCreds(conn);
  const out = { checked: 0, imported: 0, failed: 0 };
  if (!conn || !s.enabled || !c.pageId || !c.pageToken) return out;
  const api: MetaApi = metaApi(fetcherOf(app), c.version, c.pageToken, 25_000);
  const since = Math.floor(Math.max(Date.parse(s.polled_at ?? '') || 0, Date.parse(s.enabled_at ?? '') || 0, Date.now() - 7 * 86400_000) / 1000) - 120;
  const started = now();
  const forms = new Map<string, string>();
  for (const f of app.db.all<{ form_id: string; name: string }>(`SELECT form_id, name FROM ads_leadforms WHERE location_id = ? AND form_id != ''`, locationId)) forms.set(f.form_id, f.name);
  try {
    const r = await api.call<any>('GET', `${c.pageId}/leadgen_forms?fields=id,name,status&limit=100`);
    for (const f of Array.isArray(r?.data) ? r.data : []) if (f?.id && String(f.status ?? 'ACTIVE') !== 'DELETED') forms.set(String(f.id), forms.get(String(f.id)) ?? String(f.name ?? ''));
  } catch {
    /* the forms we know are still polled */
  }
  for (const [formId, name] of forms) {
    try {
      for (const lead of await listFormLeads(api, formId, since)) {
        out.checked++;
        const res = importLead(app, locationId, { ...lead, page_id: c.pageId, form_id: lead.form_id ?? formId }, 'poll', { tags: s.tags, formName: name });
        if (res.status === 'imported') out.imported++;
        else if (res.status === 'failed') out.failed++;
      }
    } catch (e) {
      out.failed++;
      console.warn('[ads] lead poll', locationId, formId, (e as Error).message);
    }
  }
  saveConnection(app, locationId, 'meta', { config: { leads: { ...(conn.config.leads ?? {}), polled_at: started } } });
  return out;
}
