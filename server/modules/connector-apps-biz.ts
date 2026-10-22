import { createHash } from 'node:crypto';
import type { App, Module } from '../core/app.js';
import { normalizePhone, sha256 } from '../core/util.js';
import { appCall, appMeta, basic, MAP_FIELD, NANGO_FIELD, saveResult, setVars, usesNango, whenOf, WHEN_FIELDS, type AppSpec } from '../services/app-kit.js';
import { connectorFetch, readJson, registerConnector, type ConnectorConfig } from '../services/connectors.js';
import { parseNumber } from '../services/formatters.js';
import { stripeRequest, StripeError } from '../services/stripe.js';
import { registerActionMeta, requireText, rowsOf, text, tzOf, type ActionMeta, type FieldDef } from '../services/wfx-kit.js';

/**
 * Native app steps without Composio, part 2 – business tools: HubSpot (create/update contact), Mailchimp and Brevo (add to list),
 * Shopify (create discount code, get order), WooCommerce (get order), Stripe (create customer / payment link, with the
 * sub-account's own Stripe key), Calendly (cancel meeting), Typeform (fetch a response) and Zoom (create meeting).
 * Credentials: Apps → Direkt-Verbindungen (API key/token) or a Nango integration for OAuth. Docs: docs/workflow-actions.md#apps.
 */

const needToken = (cfg: ConnectorConfig, what: string) => {
  if (!usesNango(cfg) && !cfg.token) throw new Error(`${what}: Token fehlt (Apps → Direkt-Verbindungen)`);
};
const bearer = (c: ConnectorConfig): Record<string, string> => (c.token ? { authorization: `Bearer ${c.token}` } : {});
const stableId = (run: any, step: any, extra = '') => sha256(`${run.id}:${step.id ?? ''}:${extra}`).slice(0, 32);
const short = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);

// --- pure helpers (tested) ---------------------------------------------------------------------------

/** Mailchimp's member id: MD5 of the lower-case address. */
export const mailchimpHash = (email: string) => createHash('md5').update(email.trim().toLowerCase()).digest('hex');

/** The data center of a Mailchimp key ("…-us21" → "us21"), checked so it can never name another host. */
export function mailchimpDc(key: string): string {
  const dc = String(key ?? '').split('-')[1] ?? '';
  if (!/^[a-z]{2,4}\d{1,2}$/.test(dc)) throw new Error('Mailchimp: Der API-Key endet nicht auf ein Rechenzentrum wie -us21');
  return dc;
}

/** The Calendly event id from a URI (…/scheduled_events/UUID[/invitees/…]) or a bare id. */
export function calendlyEventId(input: string): string | null {
  const s = String(input ?? '').trim();
  const m = s.match(/scheduled_events\/([0-9a-f-]{36})/i) ?? s.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1].toLowerCase() : null;
}

/** One Typeform answer as readable text. */
export function typeformAnswer(a: any): string {
  switch (a?.type) {
    case 'text': return String(a.text ?? '');
    case 'email': return String(a.email ?? '');
    case 'phone_number': return String(a.phone_number ?? '');
    case 'url': return String(a.url ?? '');
    case 'file_url': return String(a.file_url ?? '');
    case 'date': return String(a.date ?? '');
    case 'number': return String(a.number ?? '');
    case 'boolean': return a.boolean ? 'Ja' : 'Nein';
    case 'choice': return String(a.choice?.label ?? a.choice?.other ?? '');
    case 'choices': return [...(a.choices?.labels ?? []), ...(a.choices?.other ? [a.choices.other] : [])].join(', ');
    case 'payment': return [a.payment?.amount, a.payment?.success === false ? '(fehlgeschlagen)' : ''].filter(Boolean).join(' ');
    default: return '';
  }
}

/** Typeform answers by the field's reference and as "Frage: Antwort" lines (titles from the form definition when known). */
export function typeformAnswers(response: any, titles: Record<string, string> = {}): { byRef: Record<string, string>; lines: string } {
  const byRef: Record<string, string> = {};
  const lines: string[] = [];
  for (const a of Array.isArray(response?.answers) ? response.answers.slice(0, 200) : []) {
    const key = String(a?.field?.ref ?? a?.field?.id ?? '');
    if (!key) continue;
    const v = typeformAnswer(a).slice(0, 5000);
    byRef[key] = v;
    lines.push(`${titles[String(a.field?.id)] ?? key}: ${v}`);
  }
  return { byRef, lines: lines.join('\n') };
}

/** A discount code that is the same for a repeated run of the same step (so a retry does not create a second one). */
export const autoDiscountCode = (seed: string) => `GH${sha256(seed).slice(0, 8).toUpperCase()}`;

/** The decimal text Shopify expects for money ("12.50"). */
export const decimal = (n: number) => n.toFixed(2);

/** Shopify order lookup: a GraphQL id for ids and long numbers, else a search on the order name (#1001). */
export function shopifyOrderRef(input: string): { id?: string; query?: string } {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('Bestellung fehlt (Nummer wie #1001 oder ID)');
  const gid = s.match(/^gid:\/\/shopify\/Order\/(\d{3,20})$/);
  if (gid) return { id: s };
  if (/^\d{10,20}$/.test(s)) return { id: `gid://shopify/Order/${s}` };
  const name = s.match(/^#?([\w-]{1,40})$/);
  if (!name) throw new Error('Bestellnummer ungültig (z. B. #1001)');
  return { query: `name:#${name[1]}` };
}

// --- specs ---------------------------------------------------------------------------------------------

const hubspotSpec: AppSpec = { name: 'HubSpot', base: () => 'https://api.hubapi.com', headers: bearer };
const mailchimpSpec: AppSpec = { name: 'Mailchimp', base: (c) => `https://${mailchimpDc(c.api_key)}.api.mailchimp.com/3.0`, headers: (c): Record<string, string> => (c.api_key ? { authorization: basic('gohigh', c.api_key) } : {}), nangoPrefix: '/3.0' };
const brevoSpec: AppSpec = { name: 'Brevo', base: () => 'https://api.brevo.com/v3', headers: (c): Record<string, string> => (c.api_key ? { 'api-key': c.api_key } : {}) };
const SHOPIFY_VERSION = '2026-04';
const shopifySpec = (c: ConnectorConfig): AppSpec => ({ name: 'Shopify', base: (x) => `https://${x.shop}/admin/api/${x.api_version || SHOPIFY_VERSION}`, headers: (x): Record<string, string> => (x.token ? { 'x-shopify-access-token': x.token } : {}), nangoPrefix: `/admin/api/${c.api_version || SHOPIFY_VERSION}` });
const wooSpec: AppSpec = { name: 'WooCommerce', base: (c) => `${c.store_url.replace(/\/+$/, '')}/wp-json/wc/v3`, headers: (c): Record<string, string> => (c.consumer_key && c.consumer_secret ? { authorization: basic(c.consumer_key, c.consumer_secret) } : {}) };
const calendlySpec: AppSpec = { name: 'Calendly', base: () => 'https://api.calendly.com', headers: bearer };
const typeformSpec: AppSpec = { name: 'Typeform', base: (c) => c.base_url || 'https://api.typeform.com', headers: bearer };
const zoomSpec: AppSpec = { name: 'Zoom', base: () => 'https://api.zoom.us/v2', nangoPrefix: '/v2' };

// --- Zoom server-to-server token (cached for its lifetime) ----------------------------------------------

const zoomTokens = new Map<string, { token: string; exp: number }>();
async function zoomToken(app: App, locationId: string, cfg: ConnectorConfig): Promise<string> {
  const key = `${locationId}:${cfg.account_id}:${cfg.client_id}`;
  const hit = zoomTokens.get(key);
  if (hit && hit.exp - Date.now() > 60_000) return hit.token;
  const r = await connectorFetch(app)(`https://zoom.us/oauth/token?${new URLSearchParams({ grant_type: 'account_credentials', account_id: cfg.account_id })}`, {
    method: 'POST',
    headers: { authorization: basic(cfg.client_id, cfg.client_secret), 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
    timeoutMs: 15_000,
    maxBytes: 64 * 1024,
  });
  const data = await readJson(r, 'Zoom');
  if (!data?.access_token) throw new Error('Zoom: keine Zugangsdaten erhalten – Account-ID, Client-ID und Secret prüfen');
  zoomTokens.set(key, { token: String(data.access_token), exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return String(data.access_token);
}

// --- field sets ------------------------------------------------------------------------------------------

const propertyRows = (label: string, ph: string): FieldDef => ({ key: 'rows', label, type: 'rows', addLabel: '+ Eigenschaft', rows: [{ key: 'property', label: 'Interner Name', type: 'text', placeholder: ph }, { key: 'value', label: 'Wert', type: 'text' }] });
const PERSON_FIELDS = (prefix = ''): FieldDef[] => [
  { key: 'first_name', label: 'Vorname', type: 'text', default: '{{contact.first_name}}' },
  { key: 'last_name', label: 'Nachname', type: 'text', default: '{{contact.last_name}}' },
  { key: 'phone', label: 'Telefon', type: 'text', default: '{{contact.phone}}', help: prefix },
];

export const connectorAppsBizModule: Module = {
  name: 'connector-apps-biz',
  register(app) {
    const metas: ActionMeta[] = [];
    const meta = (m: ReturnType<typeof appMeta>) => void metas.push(m);
    const loc = (run: any) => run.location_id as string;

    // ---- HubSpot -----------------------------------------------------------------------------------
    const hubspotProps = (step: any, vars: Record<string, any>, withEmail: boolean): Record<string, string> => {
      const p: Record<string, string> = {};
      const set = (k: string, v: string) => {
        const t = v.trim();
        if (t !== '') p[k] = t.slice(0, 5000);
      };
      if (withEmail) set('email', text(step.email, vars));
      set('firstname', text(step.first_name, vars));
      set('lastname', text(step.last_name, vars));
      set('phone', text(step.phone, vars));
      set('company', text(step.company, vars));
      for (const r of rowsOf<{ property: string; value: string }>(step.rows, ['property'], 50)) {
        const k = String(r.property).trim();
        if (!/^[a-z][a-z0-9_]{0,99}$/.test(k)) throw new Error(`HubSpot-Eigenschaft „${k.slice(0, 40)}“ ist ungültig (interner Name in Kleinbuchstaben, z. B. lifecyclestage)`);
        set(k, text(r.value, vars));
      }
      return p;
    };
    const hubspotOut = (r: { data: any }, created: boolean, text0: string) => setVars({ result: text0, output: { id: r.data?.id, created } }, { hubspot_contact_id: r.data?.id, hubspot_created: created });
    registerConnector(app, {
      key: 'hubspot',
      name: 'HubSpot',
      category: 'CRM & Vertrieb',
      icon: 'contacts',
      description: 'Kontakte in HubSpot anlegen oder aktualisieren – ohne Zwischendienst.',
      credentials: 'Token einer privaten HubSpot-App (Einstellungen → Integrationen → Private Apps, Recht crm.objects.contacts.write) unter Apps → Direkt-Verbindungen – oder eine Nango-Integration.',
      guide: ['HubSpot → Einstellungen → Integrationen → Private Apps → App erstellen → Bereiche „crm.objects.contacts.read“ und „.write“.', 'Das Zugriffstoken (pat-…) hier eintragen und „Verbindung testen“.', 'Im Workflow „HubSpot: Kontakt anlegen“ oder „… aktualisieren“.'],
      fields: [{ key: 'token', label: 'Zugriffstoken', secret: true, max: 300, pattern: /^pat-[a-z0-9]+-[\w-]{20,200}$/i, patternHint: 'Das Token einer privaten App beginnt mit pat-', placeholder: 'pat-eu1-…' }, NANGO_FIELD],
      steps: ['HubSpot: Kontakt anlegen', 'HubSpot: Kontakt aktualisieren'],
      test: async (a, cfg) => {
        needToken(cfg, 'HubSpot');
        await appCall(a, '', cfg, hubspotSpec, { path: '/crm/v3/objects/contacts', query: { limit: 1 } });
        return 'Verbunden – Kontakte lesbar';
      },
      actions: {
        hubspot_create_contact: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'HubSpot');
          const props = hubspotProps(step, vars, true);
          if (!props.email) throw new Error('E-Mail fehlt');
          const r = await appCall(a, loc(run), cfg, hubspotSpec, { method: 'POST', path: '/crm/v3/objects/contacts', body: { properties: props }, accept: [409] });
          if (r.status !== 409) return saveResult(hubspotOut(r, true, `HubSpot: Kontakt ${r.data?.id ?? ''} angelegt`), step, r.data?.id);
          const id = String(r.data?.message ?? '').match(/Existing ID:\s*(\d+)/i)?.[1];
          if (!id) throw new Error('HubSpot: Kontakt existiert schon, die ID wurde nicht mitgeteilt');
          if (step.update_existing === false) return saveResult(setVars({ result: `HubSpot: Kontakt ${id} existiert bereits (nicht geändert)` }, { hubspot_contact_id: id, hubspot_created: false }), step, id);
          const u = await appCall(a, loc(run), cfg, hubspotSpec, { method: 'PATCH', path: `/crm/v3/objects/contacts/${id}`, body: { properties: props } });
          return saveResult(hubspotOut({ data: { id, ...u.data } }, false, `HubSpot: vorhandenen Kontakt ${id} aktualisiert`), step, id);
        },
        hubspot_update_contact: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'HubSpot');
          const id = text(step.contact_id, vars).trim();
          const email = text(step.email, vars).trim();
          if (!id && !email) throw new Error('HubSpot-ID oder E-Mail zum Suchen fehlt');
          if (id && !/^\d{1,20}$/.test(id)) throw new Error('HubSpot-ID ist ungültig (nur Ziffern)');
          const props = hubspotProps(step, vars, false);
          if (!Object.keys(props).length) throw new Error('Keine Eigenschaften zum Ändern angegeben');
          const r = await appCall(a, loc(run), cfg, hubspotSpec, { method: 'PATCH', path: `/crm/v3/objects/contacts/${id || encodeURIComponent(email)}`, query: id ? {} : { idProperty: 'email' }, body: { properties: props }, accept: [404] });
          if (r.status === 404) {
            if (!step.create_if_missing || !email) return { result: `HubSpot: kein Kontakt gefunden (${id || email})`, vars: { hubspot_found: false } };
            const c = await appCall(a, loc(run), cfg, hubspotSpec, { method: 'POST', path: '/crm/v3/objects/contacts', body: { properties: { ...props, email } } });
            return saveResult(setVars(hubspotOut(c, true, `HubSpot: Kontakt ${c.data?.id ?? ''} neu angelegt`), { hubspot_found: false }), step, c.data?.id);
          }
          return saveResult(setVars(hubspotOut(r, false, `HubSpot: Kontakt ${r.data?.id ?? id} aktualisiert`), { hubspot_found: true }), step, r.data?.id);
        },
      },
    });
    const HUBSPOT_PERSON: FieldDef[] = [...PERSON_FIELDS(), { key: 'company', label: 'Firma', type: 'text', default: '{{contact.company}}' }, propertyRows('Weitere Eigenschaften', 'lifecyclestage')];
    meta(appMeta('HubSpot', { type: 'hubspot_create_contact', label: 'HubSpot: Kontakt anlegen', summary: 'Legt einen Kontakt in HubSpot an – ein vorhandener (gleiche E-Mail) wird aktualisiert.', doc: 'Die E-Mail ist Pflicht. Leere Felder werden nicht übertragen. Weitere Eigenschaften über ihren internen Namen (HubSpot → Einstellungen → Eigenschaften), z. B. lifecyclestage = lead. Existiert der Kontakt schon, wird er aktualisiert – oder bleibt unverändert, wenn du den Haken wegnimmst. Danach {{var.hubspot_contact_id}}.', icon: 'contacts', needs: 'Apps → Direkt-Verbindungen → HubSpot', keywords: 'hubspot crm kontakt contact anlegen', fields: [{ key: 'email', label: 'E-Mail', type: 'text', default: '{{contact.email}}', required: true }, ...HUBSPOT_PERSON, { key: 'update_existing', label: 'Vorhandenen Kontakt aktualisieren', type: 'bool', default: true }, MAP_FIELD], provides: ['var.hubspot_contact_id', 'var.hubspot_created'], sample: { email: '{{contact.email}}', first_name: '{{contact.first_name}}', rows: [{ property: 'lifecyclestage', value: 'lead' }] } }));
    meta(appMeta('HubSpot', { type: 'hubspot_update_contact', label: 'HubSpot: Kontakt aktualisieren', summary: 'Ändert Eigenschaften eines HubSpot-Kontakts – gefunden über die ID oder die E-Mail.', doc: 'Entweder die HubSpot-ID oder die E-Mail zum Suchen angeben. Nur ausgefüllte Eigenschaften werden geändert. „Anlegen, wenn nicht gefunden“ macht ein Upsert (braucht die E-Mail). {{var.hubspot_found}} sagt, ob er schon existierte.', icon: 'contacts', needs: 'Apps → Direkt-Verbindungen → HubSpot', keywords: 'hubspot crm kontakt contact ändern update upsert', fields: [{ key: 'contact_id', label: 'HubSpot-ID', type: 'text', placeholder: '{{var.hubspot_contact_id}}' }, { key: 'email', label: 'oder E-Mail zum Suchen', type: 'text', default: '{{contact.email}}' }, ...HUBSPOT_PERSON, { key: 'create_if_missing', label: 'Anlegen, wenn nicht gefunden', type: 'bool' }, MAP_FIELD], provides: ['var.hubspot_contact_id', 'var.hubspot_found'], sample: { email: '{{contact.email}}', rows: [{ property: 'lifecyclestage', value: 'customer' }], create_if_missing: true } }));

    // ---- Mailchimp -----------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'mailchimp',
      name: 'Mailchimp',
      category: 'Marketing',
      icon: 'email',
      description: 'Kontakte zu einer Mailchimp-Audience hinzufügen oder aktualisieren, mit Tags.',
      credentials: 'API-Key (Mailchimp → Konto → Extras → API-Keys, endet auf -us21 o. ä.) unter Apps → Direkt-Verbindungen; optional die Standard-Audience – oder eine Nango-Integration.',
      guide: ['Mailchimp → Profil → Extras → API-Keys → „Key erstellen“.', 'Die Audience-ID steht unter Audience → Einstellungen → „Audience name and defaults“.', 'Im Workflow „Mailchimp: Zur Audience hinzufügen“ – nur für Kontakte mit Einwilligung.'],
      fields: [{ key: 'api_key', label: 'API-Key', secret: true, max: 100, pattern: /^[a-f0-9]{32}-[a-z]{2,4}\d{1,2}$/, patternHint: 'Der Key hat die Form 32 Zeichen-us21', placeholder: '…-us21' }, { key: 'default_list_id', label: 'Standard-Audience (ID)', max: 20, pattern: /^[a-f0-9]{6,20}$/i, patternHint: 'Audience-IDs bestehen aus Buchstaben a–f und Ziffern' }, NANGO_FIELD],
      steps: ['Mailchimp: Zur Audience hinzufügen'],
      test: async (a, cfg) => {
        if (!usesNango(cfg) && !cfg.api_key) throw new Error('Mailchimp: API-Key fehlt');
        const r = await appCall(a, '', cfg, mailchimpSpec, { path: '/ping' });
        return String(r.data?.health_status ?? 'Verbunden').slice(0, 80);
      },
      actions: {
        mailchimp_add_member: async (a, cfg, run, step, vars) => {
          if (!usesNango(cfg) && !cfg.api_key) throw new Error('Mailchimp: API-Key fehlt (Apps → Direkt-Verbindungen)');
          const list = text(step.list_id, vars).trim() || cfg.default_list_id;
          if (!list || !/^[a-zA-Z0-9]{4,30}$/.test(list)) throw new Error('Audience fehlt oder ist ungültig (im Schritt oder als Standard-Audience)');
          const email = requireText(text(step.email, vars), 'E-Mail').toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-Mail ist ungültig');
          const status = ['subscribed', 'pending', 'unsubscribed'].includes(step.status) ? step.status : 'subscribed';
          const merge: Record<string, string> = {};
          const m = (k: string, v: string) => {
            if (v.trim()) merge[k] = v.trim().slice(0, 255);
          };
          m('FNAME', text(step.first_name, vars));
          m('LNAME', text(step.last_name, vars));
          const phone = normalizePhone(text(step.phone, vars));
          if (phone) m('PHONE', phone);
          for (const r of rowsOf<{ tag: string; value: string }>(step.rows, ['tag'], 30)) {
            const k = String(r.tag).trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9_]{0,9}$/.test(k)) throw new Error(`Merge-Tag „${k.slice(0, 20)}“ ist ungültig (bis 10 Zeichen, z. B. COMPANY)`);
            m(k, text(r.value, vars));
          }
          const hash = mailchimpHash(email);
          // PUT is create-or-update; status_if_new keeps an existing member's status (someone who unsubscribed stays unsubscribed)
          const r = await appCall(a, loc(run), cfg, mailchimpSpec, { method: 'PUT', path: `/lists/${list}/members/${hash}`, body: { email_address: email, status_if_new: status, ...(Object.keys(merge).length ? { merge_fields: merge } : {}) } });
          const tags = text(step.tags, vars).split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
          if (tags.length) await appCall(a, loc(run), cfg, mailchimpSpec, { method: 'POST', path: `/lists/${list}/members/${hash}/tags`, body: { tags: tags.map((name) => ({ name: name.slice(0, 100), status: 'active' })) } });
          return saveResult(setVars({ result: `Mailchimp: ${email} (${r.data?.status ?? status})${tags.length ? `, ${tags.length} Tag(s)` : ''}`, output: { id: r.data?.id, status: r.data?.status } }, { mailchimp_status: r.data?.status, mailchimp_member_id: r.data?.id }), step, r.data?.status);
        },
      },
    });
    meta(appMeta('Mailchimp', { type: 'mailchimp_add_member', label: 'Mailchimp: Zur Audience hinzufügen', summary: 'Fügt eine E-Mail-Adresse einer Mailchimp-Audience hinzu (oder aktualisiert sie), optional mit Tags.', doc: 'Nur für Kontakte mit Einwilligung! „Bestätigung per E-Mail (Double-Opt-In)“ lässt Mailchimp erst eine Bestätigungsmail schicken. Bereits abgemeldete Mitglieder bleiben abgemeldet. Merge-Tags (FNAME, LNAME, PHONE, …) werden aus den Feldern gefüllt; weitere über die Zeilen. Tags komma-getrennt. Danach {{var.mailchimp_status}}.', icon: 'email', needs: 'Apps → Direkt-Verbindungen → Mailchimp', keywords: 'mailchimp newsletter audience liste list tag abonnent', fields: [{ key: 'list_id', label: 'Audience (ID)', type: 'text' }, { key: 'email', label: 'E-Mail', type: 'text', default: '{{contact.email}}', required: true }, ...PERSON_FIELDS(), { key: 'status', label: 'Status für neue Mitglieder', type: 'select', options: [['subscribed', 'Angemeldet'], ['pending', 'Bestätigung per E-Mail (Double-Opt-In)'], ['unsubscribed', 'Abgemeldet']], default: 'subscribed' }, { key: 'tags', label: 'Tags (komma-getrennt)', type: 'text', placeholder: 'kunde, newsletter' }, { key: 'rows', label: 'Weitere Merge-Tags', type: 'rows', addLabel: '+ Merge-Tag', rows: [{ key: 'tag', label: 'Tag', type: 'text', placeholder: 'COMPANY' }, { key: 'value', label: 'Wert', type: 'text' }] }, MAP_FIELD], provides: ['var.mailchimp_status', 'var.mailchimp_member_id'], sample: { email: '{{contact.email}}', status: 'pending', tags: 'kunde' } }));

    // ---- Brevo ---------------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'brevo',
      name: 'Brevo',
      category: 'Marketing',
      icon: 'email',
      description: 'Kontakte in Brevo (früher Sendinblue) anlegen oder aktualisieren und Listen zuordnen.',
      credentials: 'API-Key (Brevo → SMTP & API → API-Keys) unter Apps → Direkt-Verbindungen; optional Standard-Listen.',
      guide: ['Brevo → Profilname → SMTP & API → API-Keys → neuen Key erzeugen.', 'Listen-IDs stehen unter Kontakte → Listen.', 'Im Workflow „Brevo: Kontakt hinzufügen“ – nur für Kontakte mit Einwilligung.'],
      fields: [{ key: 'api_key', label: 'API-Key', secret: true, max: 200, pattern: /^[\w-]{30,200}$/, patternHint: 'Der API-Key besteht nur aus Buchstaben, Ziffern und Bindestrichen' }, { key: 'default_list_ids', label: 'Standard-Listen (IDs, komma-getrennt)', max: 60, pattern: /^\d+(\s*,\s*\d+)*$/, patternHint: 'Listen-IDs sind Zahlen, komma-getrennt' }],
      steps: ['Brevo: Kontakt hinzufügen'],
      test: async (a, cfg) => {
        if (!cfg.api_key) throw new Error('Brevo: API-Key fehlt');
        const r = await appCall(a, '', cfg, brevoSpec, { path: '/account' });
        return `Verbunden mit ${String(r.data?.companyName || r.data?.email || 'Brevo')}`;
      },
      actions: {
        brevo_add_contact: async (a, cfg, run, step, vars) => {
          if (!cfg.api_key) throw new Error('Brevo: API-Key fehlt (Apps → Direkt-Verbindungen)');
          const email = requireText(text(step.email, vars), 'E-Mail').toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-Mail ist ungültig');
          const attrs: Record<string, string> = {};
          const set = (k: string, v: string) => {
            if (v.trim()) attrs[k] = v.trim().slice(0, 255);
          };
          set('FIRSTNAME', text(step.first_name, vars));
          set('LASTNAME', text(step.last_name, vars));
          const phone = normalizePhone(text(step.phone, vars));
          if (phone) set('SMS', phone);
          for (const r of rowsOf<{ attribute: string; value: string }>(step.rows, ['attribute'], 30)) {
            const k = String(r.attribute).trim().toUpperCase();
            if (!/^[A-Z][A-Z0-9_]{0,59}$/.test(k)) throw new Error(`Brevo-Attribut „${k.slice(0, 30)}“ ist ungültig (Großbuchstaben, Ziffern, _)`);
            set(k, text(r.value, vars));
          }
          const ids = (text(step.list_ids, vars).trim() || cfg.default_list_ids || '').split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x)).map(Number).slice(0, 20);
          const r = await appCall(a, loc(run), cfg, brevoSpec, { method: 'POST', path: '/contacts', body: { email, ...(Object.keys(attrs).length ? { attributes: attrs } : {}), ...(ids.length ? { listIds: ids } : {}), updateEnabled: step.update_existing !== false } });
          const id = r.data?.id;
          return saveResult(setVars({ result: `Brevo: ${email} ${r.status === 204 ? 'aktualisiert' : 'angelegt'}${ids.length ? ` (Liste ${ids.join(', ')})` : ''}`, output: { id } }, { brevo_contact_id: id ?? '' }), step, id);
        },
      },
    });
    meta(appMeta('Brevo', { type: 'brevo_add_contact', label: 'Brevo: Kontakt hinzufügen', summary: 'Legt einen Kontakt in Brevo an oder aktualisiert ihn und trägt ihn in Listen ein.', doc: 'Nur für Kontakte mit Einwilligung! Listen-IDs komma-getrennt (leer = Standard-Listen der Verbindung). Die Telefonnummer wird ins internationale Format gebracht (SMS-Attribut). Weitere Attribute über ihren Namen in Großbuchstaben (z. B. COMPANY). Danach {{var.brevo_contact_id}}.', icon: 'email', needs: 'Apps → Direkt-Verbindungen → Brevo', keywords: 'brevo sendinblue newsletter liste kontakt', fields: [{ key: 'email', label: 'E-Mail', type: 'text', default: '{{contact.email}}', required: true }, ...PERSON_FIELDS(), { key: 'list_ids', label: 'Listen (IDs, komma-getrennt)', type: 'text', placeholder: '3, 7' }, { key: 'update_existing', label: 'Vorhandenen Kontakt aktualisieren', type: 'bool', default: true }, { key: 'rows', label: 'Weitere Attribute', type: 'rows', addLabel: '+ Attribut', rows: [{ key: 'attribute', label: 'Attribut', type: 'text', placeholder: 'COMPANY' }, { key: 'value', label: 'Wert', type: 'text' }] }, MAP_FIELD], provides: ['var.brevo_contact_id'], sample: { email: '{{contact.email}}', list_ids: '3' } }));

    // ---- Shopify (Admin GraphQL) ---------------------------------------------------------------------
    const gql = async (a: App, locationId: string, cfg: ConnectorConfig, query: string, variables: Record<string, unknown>) => {
      if (!usesNango(cfg) && !cfg.token) throw new Error('Shopify: Token fehlt (Apps → Direkt-Verbindungen)');
      const r = await appCall(a, locationId, cfg, shopifySpec(cfg), { method: 'POST', path: '/graphql.json', body: { query, variables } });
      if (Array.isArray(r.data?.errors) && r.data.errors.length) throw new Error(`Shopify: ${String(r.data.errors[0]?.message ?? 'Fehler').slice(0, 200)}`);
      return r.data?.data ?? {};
    };
    registerConnector(app, {
      key: 'shopify',
      name: 'Shopify',
      category: 'E-Commerce',
      icon: 'cart',
      description: 'Rabattcodes erzeugen und Bestellungen abrufen – über die Shopify-Admin-API.',
      credentials: 'Shop-Adresse (name.myshopify.com) und Admin-API-Zugriffstoken einer eigenen App (shpat_…, Rechte write_discounts, read_orders) unter Apps → Direkt-Verbindungen – oder eine Nango-Integration.',
      guide: ['Shopify-Admin → Einstellungen → Apps und Vertriebskanäle → App-Entwicklung → App erstellen → Admin-API-Bereiche „write_discounts“ und „read_orders“ → installieren.', 'Das „Admin API access token“ (shpat_…) und die Adresse name.myshopify.com hier eintragen.', 'Bestellungen älter als 60 Tage braucht zusätzlich das Recht read_all_orders.'],
      fields: [
        { key: 'shop', label: 'Shop-Adresse', required: true, max: 100, pattern: /^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$/, patternHint: 'Erwartet name.myshopify.com (ohne https://)', placeholder: 'mein-shop.myshopify.com' },
        { key: 'token', label: 'Admin-API-Token', secret: true, max: 200, pattern: /^shp(at|ca|ua)_[a-f0-9]{20,100}$/i, patternHint: 'Das Token beginnt mit shpat_', placeholder: 'shpat_…' },
        { key: 'api_version', label: 'API-Version', max: 10, pattern: /^\d{4}-(01|04|07|10)$/, patternHint: 'Format JJJJ-MM mit 01, 04, 07 oder 10', placeholder: SHOPIFY_VERSION, help: `Leer = ${SHOPIFY_VERSION}.` },
        NANGO_FIELD,
      ],
      steps: ['Shopify: Rabattcode erstellen', 'Shopify: Bestellung abrufen'],
      test: async (a, cfg) => {
        const d = await gql(a, '', cfg, '{ shop { name } }', {});
        return `Verbunden mit ${String(d.shop?.name ?? 'Shopify')}`;
      },
      actions: {
        shopify_create_discount: async (a, cfg, run, step, vars) => {
          const manual = text(step.code, vars).trim().toUpperCase();
          if (manual && !/^[A-Z0-9][A-Z0-9_-]{2,40}$/.test(manual)) throw new Error('Rabattcode ungültig (3–41 Zeichen: A–Z, 0–9, _ und -)');
          const code = manual || autoDiscountCode(`${run.id}:${step.id ?? ''}`);
          const kind = step.kind === 'fixed' ? 'fixed' : 'percent';
          const value = parseNumber(text(step.value, vars));
          if (!(value > 0)) throw new Error('Rabattwert muss größer als 0 sein');
          if (kind === 'percent' && value > 100) throw new Error('Prozent-Rabatt höchstens 100');
          const days = Number(text(step.valid_days, vars));
          const minimum = parseNumber(text(step.minimum, vars));
          const limit = Number(text(step.usage_limit, vars));
          const input: Record<string, unknown> = {
            title: short(text(step.title, vars) || `HyperLevel ${code}`, 255),
            code,
            startsAt: new Date().toISOString(),
            ...(days > 0 ? { endsAt: new Date(Date.now() + Math.min(days, 3650) * 86_400_000).toISOString() } : {}),
            ...(limit > 0 ? { usageLimit: Math.floor(limit) } : {}),
            appliesOncePerCustomer: step.once_per_customer !== false,
            customerSelection: { all: true },
            customerGets: { value: kind === 'percent' ? { percentage: value / 100 } : { discountAmount: { amount: decimal(value), appliesOnEachItem: false } }, items: { all: true } },
            ...(minimum > 0 ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: decimal(minimum) } } } : {}),
          };
          const d = await gql(a, loc(run), cfg, 'mutation($d: DiscountCodeBasicInput!) { discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message code } } }', { d: input });
          const res = d.discountCodeBasicCreate;
          const err = res?.userErrors?.[0];
          if (err) {
            // a retry of the same step: the generated code exists already
            if (!manual && String(err.code) === 'TAKEN') return saveResult(setVars({ result: `Shopify: Rabattcode ${code} gab es schon (Wiederholung)`, output: { code } }, { discount_code: code }), step, code);
            throw new Error(`Shopify: ${short(err.message, 200)}`);
          }
          return saveResult(setVars({ result: `Shopify: Rabattcode ${code} erstellt (${kind === 'percent' ? `${value} %` : `${decimal(value)} €`})`, output: { code, id: res?.codeDiscountNode?.id } }, { discount_code: code, discount_id: res?.codeDiscountNode?.id ?? '' }), step, code);
        },
        shopify_get_order: async (a, cfg, run, step, vars) => {
          const ref = shopifyOrderRef(text(step.order, vars));
          const fields = 'id name email createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 20) { nodes { title quantity } }';
          const d = ref.id ? await gql(a, loc(run), cfg, `query($id: ID!) { order(id: $id) { ${fields} } }`, { id: ref.id }) : await gql(a, loc(run), cfg, `query($q: String!) { orders(first: 1, query: $q) { nodes { ${fields} } } }`, { q: ref.query });
          const o = ref.id ? d.order : d.orders?.nodes?.[0];
          if (!o) return { result: `Shopify: keine Bestellung gefunden (${short(text(step.order, vars), 40)})`, vars: { shopify_found: false } };
          const items = (o.lineItems?.nodes ?? []).map((l: any) => `${l.quantity}× ${l.title}`).join(', ');
          const money = o.totalPriceSet?.shopMoney ?? {};
          return saveResult(setVars({ result: `Shopify: Bestellung ${o.name} – ${o.displayFinancialStatus ?? ''}, ${o.displayFulfillmentStatus ?? ''}, ${money.amount ?? ''} ${money.currencyCode ?? ''}`.trim(), output: { id: o.id, name: o.name, status: o.displayFinancialStatus, total: money.amount } }, { shopify_found: true, shopify_order_id: o.id, shopify_order_name: o.name, shopify_order_status: String(o.displayFinancialStatus ?? '').toLowerCase(), shopify_fulfillment: String(o.displayFulfillmentStatus ?? '').toLowerCase(), shopify_order_total: money.amount ?? '', shopify_order_currency: money.currencyCode ?? '', shopify_order_email: o.email ?? '', shopify_order_items: items, shopify_order_cancelled: !!o.cancelledAt }), step, o.displayFinancialStatus);
        },
      },
    });
    meta(appMeta('Shopify', { type: 'shopify_create_discount', label: 'Shopify: Rabattcode erstellen', summary: 'Erzeugt einen Rabattcode im Shopify-Shop – prozentual oder als Betrag.', doc: 'Leerer Code = HyperLevel erzeugt einen (gleich bei Wiederholung, es entsteht kein zweiter). Prozent oder fester Betrag in der Währung des Shops, optional Mindestbestellwert, Gültigkeit in Tagen und Nutzungslimit. Standard: einmal pro Kunde. Danach {{var.discount_code}} z. B. in einer E-Mail.', icon: 'cart', needs: 'Apps → Direkt-Verbindungen → Shopify', keywords: 'shopify rabatt gutschein code discount coupon', fields: [{ key: 'code', label: 'Code (leer = automatisch)', type: 'text', placeholder: 'WILLKOMMEN10' }, { key: 'title', label: 'Titel im Shopify-Admin', type: 'text', placeholder: 'Willkommensrabatt {{contact.name}}' }, { key: 'kind', label: 'Art', type: 'select', options: [['percent', 'Prozent'], ['fixed', 'Fester Betrag']], default: 'percent' }, { key: 'value', label: 'Wert', type: 'text', default: '10', required: true }, { key: 'minimum', label: 'Mindestbestellwert', type: 'text' }, { key: 'valid_days', label: 'Gültig (Tage)', type: 'number', default: 14 }, { key: 'usage_limit', label: 'Nutzungslimit gesamt', type: 'number' }, { key: 'once_per_customer', label: 'Einmal pro Kunde', type: 'bool', default: true }, MAP_FIELD], provides: ['var.discount_code', 'var.discount_id'], sample: { kind: 'percent', value: '10', valid_days: 14 } }));
    meta(appMeta('Shopify', { type: 'shopify_get_order', label: 'Shopify: Bestellung abrufen', summary: 'Liest eine Shopify-Bestellung (Nummer oder ID): Status, Versand, Summe, Positionen.', doc: 'Bestellnummer wie #1001 oder die lange Bestell-ID. Ohne Treffer läuft der Workflow weiter und {{var.shopify_found}} ist falsch – prüfe das mit einer Bedingung. Danach: shopify_order_status (paid, pending, refunded …), shopify_fulfillment (fulfilled, unfulfilled …), shopify_order_total, shopify_order_items, shopify_order_email.', icon: 'cart', needs: 'Apps → Direkt-Verbindungen → Shopify', keywords: 'shopify bestellung order abrufen status versand', fields: [{ key: 'order', label: 'Bestellung (Nummer oder ID)', type: 'text', placeholder: '#1001  ·  {{event.order_number}}', required: true }, MAP_FIELD], provides: ['var.shopify_found', 'var.shopify_order_status', 'var.shopify_fulfillment', 'var.shopify_order_total', 'var.shopify_order_items', 'var.shopify_order_email'], sample: { order: '#1001' } }));

    // ---- WooCommerce ---------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'woocommerce',
      name: 'WooCommerce',
      category: 'E-Commerce',
      icon: 'cart',
      description: 'Bestellungen aus einem WooCommerce-Shop abrufen.',
      credentials: 'Shop-Adresse (https://…) sowie Consumer Key und Secret (WooCommerce → Einstellungen → Erweitert → REST-API, Leserechte) unter Apps → Direkt-Verbindungen.',
      guide: ['WooCommerce → Einstellungen → Erweitert → REST-API → „Schlüssel hinzufügen“ (Berechtigung: Lesen).', 'Consumer Key (ck_…) und Secret (cs_…) hier mit der Shop-Adresse eintragen. Der Shop muss über https erreichbar sein.'],
      fields: [
        { key: 'store_url', label: 'Shop-Adresse', required: true, max: 200, pattern: /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{2,5})?(\/[\w.~-]+)*\/?$/i, patternHint: 'Erwartet https://mein-shop.de (ohne Pfad nach /wp-json)', placeholder: 'https://mein-shop.de' },
        { key: 'consumer_key', label: 'Consumer Key', required: true, max: 80, pattern: /^ck_[a-f0-9]{20,60}$/i, patternHint: 'Der Key beginnt mit ck_' },
        { key: 'consumer_secret', label: 'Consumer Secret', required: true, secret: true, max: 80, pattern: /^cs_[a-f0-9]{20,60}$/i, patternHint: 'Das Secret beginnt mit cs_' },
      ],
      steps: ['WooCommerce: Bestellung abrufen'],
      test: async (a, cfg) => {
        const r = await appCall(a, '', cfg, wooSpec, { path: '/orders', query: { per_page: 1 } });
        return `Verbunden – ${Array.isArray(r.data) ? 'Bestellungen lesbar' : 'Antwort erhalten'}`;
      },
      actions: {
        woocommerce_get_order: async (a, cfg, run, step, vars) => {
          const id = text(step.order_id, vars).trim().replace(/^#/, '');
          if (!/^\d{1,12}$/.test(id)) throw new Error('Bestellnummer ungültig (nur Ziffern, z. B. 1234)');
          const r = await appCall(a, loc(run), cfg, wooSpec, { path: `/orders/${id}`, accept: [404] });
          if (r.status === 404) return { result: `WooCommerce: keine Bestellung ${id}`, vars: { woo_found: false } };
          const o = r.data ?? {};
          const items = (Array.isArray(o.line_items) ? o.line_items : []).slice(0, 20).map((l: any) => `${l.quantity}× ${l.name}`).join(', ');
          return saveResult(setVars({ result: `WooCommerce: Bestellung ${id} – ${o.status ?? ''}, ${o.total ?? ''} ${o.currency ?? ''}`.trim(), output: { id: o.id, status: o.status, total: o.total } }, { woo_found: true, woo_order_status: String(o.status ?? ''), woo_order_total: String(o.total ?? ''), woo_order_currency: String(o.currency ?? ''), woo_order_email: String(o.billing?.email ?? ''), woo_order_items: items, woo_payment_method: String(o.payment_method_title ?? o.payment_method ?? ''), woo_order_date: String(o.date_created_gmt ?? o.date_created ?? '') }), step, o.status);
        },
      },
    });
    meta(appMeta('WooCommerce', { type: 'woocommerce_get_order', label: 'WooCommerce: Bestellung abrufen', summary: 'Liest eine WooCommerce-Bestellung: Status, Summe, Positionen, Zahlart.', doc: 'Die Bestellnummer ist in WooCommerce die ID der Bestellung. Ohne Treffer läuft der Workflow weiter und {{var.woo_found}} ist falsch. Danach: woo_order_status (pending, processing, completed, refunded …), woo_order_total, woo_order_items, woo_order_email, woo_payment_method.', icon: 'cart', needs: 'Apps → Direkt-Verbindungen → WooCommerce', keywords: 'woocommerce woo bestellung order wordpress shop', fields: [{ key: 'order_id', label: 'Bestellnummer', type: 'text', placeholder: '1234  ·  {{event.order_id}}', required: true }, MAP_FIELD], provides: ['var.woo_found', 'var.woo_order_status', 'var.woo_order_total', 'var.woo_order_items', 'var.woo_order_email'], sample: { order_id: '1234' } }));

    // ---- Stripe (the sub-account's own key from Einstellungen → Stripe) ------------------------------------
    const stripeFor = (run: any): string => {
      const key = (app.services.stripeKey as ((loc: string) => string) | undefined)?.(run.location_id);
      if (!key) throw new Error('Stripe ist in diesem Sub-Account nicht verbunden (Einstellungen → Stripe).');
      return key;
    };
    const stripeCall = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof StripeError) throw new Error(e.message.startsWith('Stripe') ? e.message : `Stripe: ${e.message}`);
        throw e;
      }
    };
    const stripeActions = {
      stripe_create_customer: async (run: any, step: any, vars: Record<string, any>) => {
        const key = stripeFor(run);
        const email = text(step.email, vars).trim();
        const name = text(step.name, vars).trim();
        if (!email && !name) throw new Error('E-Mail oder Name fehlt');
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-Mail ist ungültig');
        if (step.reuse_existing !== false && email) {
          const found = await stripeCall(() => stripeRequest<any>(key, 'GET', '/v1/customers', { email, limit: 1 }));
          const c = found?.data?.[0];
          if (c) return saveResult(setVars({ result: `Stripe: Kunde ${c.id} gab es schon`, output: { id: c.id, created: false } }, { stripe_customer_id: c.id, stripe_customer_created: false }), step, c.id);
        }
        const phone = normalizePhone(text(step.phone, vars));
        const c = await stripeCall(() => stripeRequest<any>(key, 'POST', '/v1/customers', { email: email || undefined, name: name || undefined, phone: phone || undefined, description: short(text(step.description, vars), 300) || undefined, metadata: { ghl_contact_id: run.contact_id ?? '', ghl_location: run.location_id } }, { idempotencyKey: `ghl-cus-${stableId(run, step)}` }));
        return saveResult(setVars({ result: `Stripe: Kunde ${c.id} angelegt`, output: { id: c.id, created: true } }, { stripe_customer_id: c.id, stripe_customer_created: true }), step, c.id);
      },
      stripe_create_payment_link: async (run: any, step: any, vars: Record<string, any>) => {
        const key = stripeFor(run);
        const name = short(requireText(text(step.name, vars), 'Produktname'), 250);
        const amount = parseNumber(text(step.amount, vars));
        const cents = Math.round(amount * 100);
        if (!(cents >= 50)) throw new Error('Betrag ungültig (mindestens 0,50)');
        if (cents > 99_999_999) throw new Error('Betrag zu hoch');
        const currency = String(step.currency || 'eur').trim().toLowerCase();
        if (!/^[a-z]{3}$/.test(currency)) throw new Error('Währung ungültig (z. B. eur)');
        const interval = ['month', 'year', 'week'].includes(step.interval) ? step.interval : '';
        const redirect = text(step.redirect_url, vars).trim();
        if (redirect && !/^https:\/\/[^\s]{4,500}$/.test(redirect)) throw new Error('Weiterleitung muss mit https:// beginnen');
        const id = stableId(run, step);
        const meta = { ghl_contact_id: run.contact_id ?? '', ghl_location: run.location_id };
        // Payment Links need a price: product → price → link, each with an idempotency key so a retried step creates no duplicates
        const product = await stripeCall(() => stripeRequest<any>(key, 'POST', '/v1/products', { name, metadata: meta }, { idempotencyKey: `ghl-prod-${id}` }));
        const price = await stripeCall(() => stripeRequest<any>(key, 'POST', '/v1/prices', { product: product.id, unit_amount: cents, currency, ...(interval ? { recurring: { interval } } : {}) }, { idempotencyKey: `ghl-price-${id}` }));
        const qty = Math.min(100, Math.max(0, Math.floor(Number(step.max_quantity) || 0)));
        const link = await stripeCall(() =>
          stripeRequest<any>(key, 'POST', '/v1/payment_links', { line_items: [{ price: price.id, quantity: 1, ...(qty > 1 ? { adjustable_quantity: { enabled: true, minimum: 1, maximum: qty } } : {}) }], ...(redirect ? { after_completion: { type: 'redirect', redirect: { url: redirect } } } : {}), metadata: meta }, { idempotencyKey: `ghl-link-${id}` }),
        );
        return saveResult(setVars({ result: `Stripe: Zahlungslink ${String(link.url ?? '').slice(0, 80)} (${(cents / 100).toFixed(2)} ${currency.toUpperCase()})`, output: { url: link.url, id: link.id, price: price.id } }, { stripe_payment_link: link.url, stripe_payment_link_id: link.id }), step, link.url);
      },
    };
    const stripeNeeds = 'Einstellungen → Stripe (Secret Key des Sub-Accounts)';
    meta(appMeta('Stripe', { type: 'stripe_create_customer', label: 'Stripe: Kunde anlegen', summary: 'Legt einen Kunden in Stripe an – einen vorhandenen mit gleicher E-Mail nimmt HyperLevel wieder.', doc: 'Nutzt den Stripe-Key des Sub-Accounts. Mit „Vorhandenen Kunden verwenden“ (Standard) entsteht kein Duplikat. Danach {{var.stripe_customer_id}}, z. B. in einem Kontaktfeld gespeichert. Mit einem Live-Key entstehen echte Kunden.', icon: 'card', needs: stripeNeeds, keywords: 'stripe kunde customer anlegen', fields: [{ key: 'email', label: 'E-Mail', type: 'text', default: '{{contact.email}}' }, { key: 'name', label: 'Name', type: 'text', default: '{{contact.name}}' }, { key: 'phone', label: 'Telefon', type: 'text', default: '{{contact.phone}}' }, { key: 'description', label: 'Beschreibung', type: 'text' }, { key: 'reuse_existing', label: 'Vorhandenen Kunden verwenden', type: 'bool', default: true }, MAP_FIELD], provides: ['var.stripe_customer_id', 'var.stripe_customer_created'], sample: { email: '{{contact.email}}', name: '{{contact.name}}' } }));
    meta(appMeta('Stripe', { type: 'stripe_create_payment_link', label: 'Stripe: Zahlungslink erstellen', summary: 'Erzeugt einen Stripe-Zahlungslink für einen Betrag, einmalig oder als Abo.', doc: 'Legt Produkt, Preis und Zahlungslink an (bei Wiederholung des Schritts ohne Duplikate). Betrag mit Komma oder Punkt (z. B. 49,90). Optional als Abo (Woche/Monat/Jahr), mit wählbarer Menge und Weiterleitung nach der Zahlung. Danach {{var.stripe_payment_link}} z. B. in einer Nachricht. Die Zahlung erscheint in Stripe; HyperLevel bucht sie nicht als Rechnung – dafür gibt es „Rechnung erstellen / Zahlungslink“ im Bereich Zahlung. Mit einem Live-Key echte Links.', icon: 'card', needs: stripeNeeds, keywords: 'stripe zahlungslink payment link bezahlen checkout abo', fields: [{ key: 'name', label: 'Produktname', type: 'text', default: 'Beratung', required: true }, { key: 'amount', label: 'Betrag', type: 'text', default: '49,90', required: true }, { key: 'currency', label: 'Währung', type: 'text', default: 'eur' }, { key: 'interval', label: 'Wiederkehrend', type: 'select', options: [['', 'Einmalig'], ['week', 'Wöchentlich'], ['month', 'Monatlich'], ['year', 'Jährlich']], default: '' }, { key: 'max_quantity', label: 'Wählbare Menge bis (0 = fest 1)', type: 'number', default: 0 }, { key: 'redirect_url', label: 'Weiterleitung nach Zahlung (https)', type: 'text' }, MAP_FIELD], provides: ['var.stripe_payment_link', 'var.stripe_payment_link_id'], sample: { name: 'Beratung', amount: '49,90', currency: 'eur' } }));

    // ---- Calendly ---------------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'calendly',
      name: 'Calendly',
      category: 'Termine',
      icon: 'calendars',
      description: 'Calendly-Termine aus einem Workflow absagen – z. B. nach einer Stornierung im CRM.',
      credentials: 'Personal Access Token (Calendly → Integrationen → API & Webhooks) unter Apps → Direkt-Verbindungen – oder eine Nango-Integration.',
      guide: ['Calendly → Integrationen → API & Webhooks → „Personal Access Token“ erzeugen.', 'Die Termin-ID kommt z. B. aus einem Calendly-Webhook (eingehender Webhook-Trigger: Feld event.uri) – die Bezahl-Funktion „Webhook-Abonnements“ ist bei Calendly nötig.', 'Im Workflow „Calendly: Termin absagen“.'],
      fields: [{ key: 'token', label: 'Personal Access Token', secret: true, max: 1000, pattern: /^[\w.-]{30,1000}$/, patternHint: 'Das Token besteht aus Buchstaben, Ziffern, Punkten und Bindestrichen' }, NANGO_FIELD],
      steps: ['Calendly: Termin absagen'],
      test: async (a, cfg) => {
        needToken(cfg, 'Calendly');
        const r = await appCall(a, '', cfg, calendlySpec, { path: '/users/me' });
        return `Verbunden als ${String(r.data?.resource?.name ?? 'Calendly')}`;
      },
      actions: {
        calendly_cancel_event: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Calendly');
          const id = calendlyEventId(text(step.event, vars));
          if (!id) throw new Error('Termin-ID fehlt oder ist ungültig (die URI aus Calendly: …/scheduled_events/<id>)');
          const reason = short(text(step.reason, vars), 1000);
          await appCall(a, loc(run), cfg, calendlySpec, { method: 'POST', path: `/scheduled_events/${id}/cancellation`, body: reason ? { reason } : {} });
          return setVars({ result: `Calendly: Termin ${id.slice(0, 8)}… abgesagt` }, { calendly_cancelled: true });
        },
      },
    });
    meta(appMeta('Calendly', { type: 'calendly_cancel_event', label: 'Calendly: Termin absagen', summary: 'Sagt einen Calendly-Termin ab und teilt dem Gast optional den Grund mit.', doc: 'Die Termin-ID oder -URI (…/scheduled_events/<id>), meist aus einem Calendly-Webhook über den Trigger „Eingehender Webhook“ (z. B. {{event.payload.event}}). Der Grund geht an den Gast. Das Absagen lässt sich nicht zurücknehmen.', icon: 'calendars', needs: 'Apps → Direkt-Verbindungen → Calendly', keywords: 'calendly termin absagen stornieren cancel', fields: [{ key: 'event', label: 'Termin (URI oder ID)', type: 'text', placeholder: '{{event.payload.event}}', required: true }, { key: 'reason', label: 'Grund (geht an den Gast)', type: 'textarea' }], provides: ['var.calendly_cancelled'], sample: { event: 'https://api.calendly.com/scheduled_events/00000000-0000-0000-0000-000000000000', reason: 'Der Termin muss leider ausfallen.' } }));

    // ---- Typeform ---------------------------------------------------------------------------------------
    registerConnector(app, {
      key: 'typeform',
      name: 'Typeform',
      category: 'Formulare',
      icon: 'survey',
      description: 'Antworten aus Typeform abrufen und im Workflow verwenden.',
      credentials: 'Personal Access Token (Typeform → Konto → Persönliche Token, Recht responses:read, forms:read) unter Apps → Direkt-Verbindungen – oder eine Nango-Integration.',
      guide: ['Typeform → Konto → „Persönliche Token“ → Token mit „Responses: Read“ (und „Forms: Read“ für die Fragentitel).', 'EU-Konten tragen als Adresse https://api.eu.typeform.com ein.', 'Im Workflow „Typeform: Antwort abrufen“ – mit der Antwort-ID aus einem Webhook oder die neueste/über eine Suche.'],
      fields: [{ key: 'token', label: 'Personal Access Token', secret: true, max: 200, pattern: /^[\w.-]{20,200}$/ }, { key: 'base_url', label: 'API-Adresse (nur EU)', max: 60, pattern: /^https:\/\/api(\.eu)?\.typeform\.com$/, patternHint: 'Nur https://api.typeform.com oder https://api.eu.typeform.com', placeholder: 'https://api.eu.typeform.com' }, NANGO_FIELD],
      steps: ['Typeform: Antwort abrufen'],
      test: async (a, cfg) => {
        needToken(cfg, 'Typeform');
        const r = await appCall(a, '', cfg, typeformSpec, { path: '/me' });
        return `Verbunden als ${String(r.data?.alias || r.data?.email || 'Typeform')}`;
      },
      actions: {
        typeform_get_response: async (a, cfg, run, step, vars) => {
          needToken(cfg, 'Typeform');
          const form = text(step.form_id, vars).trim();
          if (!/^[A-Za-z0-9]{4,30}$/.test(form)) throw new Error('Formular-ID fehlt oder ist ungültig (steht in der Typeform-URL …/to/<id>)');
          const rid = text(step.response_id, vars).trim();
          const q = text(step.query, vars).trim();
          if (rid && !/^[\w-]{3,100}$/.test(rid)) throw new Error('Antwort-ID ungültig');
          const r = await appCall(a, loc(run), cfg, typeformSpec, { path: `/forms/${form}/responses`, query: { page_size: 1, ...(rid ? { included_response_ids: rid } : {}), ...(q && !rid ? { query: q.slice(0, 200) } : {}) } });
          const item = r.data?.items?.[0];
          if (!item) return { result: `Typeform: keine Antwort gefunden${rid ? ` (${rid.slice(0, 20)})` : q ? ` für „${q.slice(0, 30)}“` : ''}`, vars: { typeform_found: false } };
          // titles of the questions from the form definition (best effort – needs forms:read)
          const titles: Record<string, string> = {};
          try {
            const def = await appCall(a, loc(run), cfg, typeformSpec, { path: `/forms/${form}` });
            for (const f of Array.isArray(def.data?.fields) ? def.data.fields : []) if (f?.id) titles[String(f.id)] = short(f.title, 120);
          } catch {
            /* refs only */
          }
          const { byRef, lines } = typeformAnswers(item, titles);
          return saveResult(setVars({ result: `Typeform: Antwort ${String(item.response_id).slice(0, 12)} (${Object.keys(byRef).length} Antworten)`, output: { response_id: item.response_id, submitted_at: item.submitted_at, answers: byRef } }, { typeform_found: true, typeform: byRef, typeform_text: lines, typeform_response_id: item.response_id, typeform_submitted_at: item.submitted_at, typeform_hidden: item.hidden ?? {}, typeform_score: item.calculated?.score ?? '' }), step, lines);
        },
      },
    });
    meta(appMeta('Typeform', { type: 'typeform_get_response', label: 'Typeform: Antwort abrufen', summary: 'Holt eine Typeform-Antwort (per ID, über eine Suche oder die neueste) und stellt sie als Variablen bereit.', doc: 'Formular-ID aus der Typeform-URL. Mit Antwort-ID (z. B. aus dem Typeform-Webhook) genau diese Antwort, sonst – mit „Suche“ (z. B. die E-Mail des Kontakts) – die erste passende, ohne beides die neueste. Die Antworten stehen als {{var.typeform.<referenz>}} (Referenz je Frage in Typeform → Frage → Einstellungen) und gesammelt als {{var.typeform_text}} („Frage: Antwort“).', icon: 'survey', needs: 'Apps → Direkt-Verbindungen → Typeform', keywords: 'typeform antwort response formular umfrage', fields: [{ key: 'form_id', label: 'Formular-ID', type: 'text', required: true, placeholder: 'AbC123xY' }, { key: 'response_id', label: 'Antwort-ID', type: 'text', placeholder: '{{event.form_response.token}}' }, { key: 'query', label: 'oder Suche in den Antworten', type: 'text', placeholder: '{{contact.email}}' }, MAP_FIELD], provides: ['var.typeform_found', 'var.typeform', 'var.typeform_text', 'var.typeform_response_id', 'var.typeform_hidden'], sample: { form_id: 'AbC123xY', query: '{{contact.email}}' } }));

    // ---- Zoom (Server-to-Server OAuth) --------------------------------------------------------------------
    registerConnector(app, {
      key: 'zoom',
      name: 'Zoom',
      category: 'Termine',
      icon: 'video',
      description: 'Zoom-Meetings aus einem Workflow anlegen und den Beitrittslink weitergeben.',
      credentials: 'Account-ID, Client-ID und Client-Secret einer Server-to-Server-OAuth-App (Zoom App Marketplace, Recht meeting:write:meeting:admin) und die E-Mail des Gastgebers unter Apps → Direkt-Verbindungen – oder eine Nango-Integration.',
      guide: ['marketplace.zoom.us → Develop → Build App → „Server-to-Server OAuth“ → Bereich „meeting:write:meeting:admin“ → aktivieren.', 'Account-ID, Client-ID und Client-Secret hier eintragen sowie die E-Mail eines Zoom-Nutzers als Gastgeber.', 'Im Workflow „Zoom: Meeting anlegen“; {{var.zoom_join_url}} an den Kontakt schicken.'],
      fields: [
        { key: 'account_id', label: 'Account-ID', max: 60, pattern: /^[\w-]{10,60}$/, patternHint: 'Buchstaben, Ziffern, - und _' },
        { key: 'client_id', label: 'Client-ID', max: 60, pattern: /^[\w-]{10,60}$/, patternHint: 'Buchstaben, Ziffern, - und _' },
        { key: 'client_secret', label: 'Client-Secret', secret: true, max: 100, pattern: /^[\w-]{10,100}$/, patternHint: 'Buchstaben, Ziffern, - und _' },
        { key: 'default_host', label: 'Gastgeber (E-Mail)', max: 200, pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHint: 'Eine E-Mail-Adresse eines Zoom-Nutzers', help: 'Server-to-Server-Apps haben keinen eigenen Nutzer – der Gastgeber muss angegeben werden.' },
        NANGO_FIELD,
      ],
      steps: ['Zoom: Meeting anlegen'],
      test: async (a, cfg) => {
        if (usesNango(cfg)) {
          const r = await appCall(a, '', cfg, zoomSpec, { path: '/users/me' });
          return `Verbunden als ${String(r.data?.email ?? 'Zoom')}`;
        }
        if (!cfg.account_id || !cfg.client_id || !cfg.client_secret) throw new Error('Zoom: Account-ID, Client-ID und Client-Secret eintragen');
        await zoomToken(a, '', cfg);
        return 'Verbunden – Zugangsdaten gültig';
      },
      actions: {
        zoom_create_meeting: async (a, cfg, run, step, vars) => {
          const direct = !usesNango(cfg);
          if (direct && !(cfg.account_id && cfg.client_id && cfg.client_secret)) throw new Error('Zoom: Zugangsdaten fehlen (Apps → Direkt-Verbindungen)');
          const topic = short(requireText(text(step.topic, vars), 'Thema'), 200);
          const { start, minutes } = whenOf(app, loc(run), step, vars);
          const host = text(step.host, vars).trim() || cfg.default_host || 'me';
          if (host !== 'me' && !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(host) && !/^[\w-]{10,40}$/.test(host)) throw new Error('Gastgeber ungültig (E-Mail oder Nutzer-ID)');
          const body = { topic, type: 2, start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: minutes, timezone: tzOf(app, loc(run)), agenda: short(text(step.agenda, vars), 2000), settings: { waiting_room: step.waiting_room !== false, join_before_host: false, host_video: true, participant_video: true } };
          const headers = direct ? { authorization: `Bearer ${await zoomToken(a, loc(run), cfg)}` } : undefined;
          const r = await appCall(a, loc(run), cfg, zoomSpec, { method: 'POST', path: `/users/${encodeURIComponent(host)}/meetings`, body, headers });
          const url = r.data?.join_url;
          if (!url) throw new Error('Zoom: Antwort ohne Beitrittslink');
          return saveResult(setVars({ result: `Zoom: Meeting ${r.data?.id} am ${start.toISOString()} angelegt`, output: { id: r.data?.id, join_url: url } }, { zoom_join_url: url, zoom_meeting_id: String(r.data?.id ?? ''), zoom_password: String(r.data?.password ?? '') }), step, url);
        },
      },
    });
    meta(appMeta('Zoom', { type: 'zoom_create_meeting', label: 'Zoom: Meeting anlegen', summary: 'Legt ein geplantes Zoom-Meeting an und liefert den Beitrittslink.', doc: 'Thema, Zeitpunkt (in X Stunden/Tagen oder zu einem Datum, dazu Uhrzeit) und Dauer. Gastgeber leer = der Gastgeber der Verbindung. Mit Warteraum (Standard) lässt der Gastgeber Teilnehmer einzeln hinein. Danach {{var.zoom_join_url}}, {{var.zoom_meeting_id}} und {{var.zoom_password}}. Bei Wiederholung des Schritts nach einem Fehler kann ein zweites Meeting entstehen – Zoom bietet keinen Schutz davor.', icon: 'video', needs: 'Apps → Direkt-Verbindungen → Zoom', keywords: 'zoom meeting videocall besprechung termin link', fields: [{ key: 'topic', label: 'Thema', type: 'text', default: 'Gespräch mit {{contact.name}}', required: true }, { key: 'agenda', label: 'Beschreibung', type: 'textarea' }, ...WHEN_FIELDS, { key: 'host', label: 'Gastgeber (E-Mail, leer = Standard)', type: 'text' }, { key: 'waiting_room', label: 'Warteraum', type: 'bool', default: true }, MAP_FIELD], provides: ['var.zoom_join_url', 'var.zoom_meeting_id', 'var.zoom_password'], sample: { topic: 'Gespräch mit {{contact.name}}', when: 'in', amount: 2, unit: 'days', time: '10:00', duration: 30 } }));

    app.services.workflowActions = { ...(app.services.workflowActions ?? {}), ...stripeActions };
    registerActionMeta(app, metas);
  },
};
