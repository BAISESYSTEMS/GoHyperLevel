import type { App, Module } from '../core/app.js';
import type { Ctx } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { getContact, type Contact } from '../services/contacts.js';
import { CHANNEL_PURPOSES, DOI_SOURCES, PURPOSE_LABEL, type ConsentChannel, type DoiSource } from '../services/consent-model.js';
import { cleanProofUrl, dispatchDoi, grantConsent, metaOf, settingsOf, type GrantResult, type SourceInfo } from '../services/consent.js';

/**
 * Where consent comes in: the hooks the lead-capturing modules call after they stored a contact (forms and funnels, webinar
 * registration, community sign-up, CSV import, API) – each records the yes with its source, text version and proof data and
 * starts the Double-Opt-in where the sub-account (or the form) wants it. They are registered on `app.services.consent`, the
 * callers use them with `?.` so the modules stay independent. A form only counts as consent when its owner says so
 * (form settings → `consent`): the old "ich stimme der Verarbeitung zu" box is not an opt-in for advertising.
 */

const truthy = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && /^(ja|yes|true|on|1|x)$/i.test(v.trim())) || (Array.isArray(v) && v.length > 0 && truthy(v[0]));

/** What a form owner can set per form (stored in forms.settings.consent). */
export interface FormConsent {
  /** The form collects an opt-in for advertising / newsletter. */
  marketing: boolean;
  /** `name` of the consent field that stands for it; empty = the first consent field of the form. Without a ticked consent field nothing is recorded: the submit button alone is no opt-in. */
  field: string;
  purposes: string[];
  /** Also ask for these channels (the contact needs a phone number for SMS / WhatsApp). */
  channels: ConsentChannel[];
  doi: 'inherit' | 'on' | 'off';
}

export function cleanFormConsent(raw: unknown): FormConsent {
  const r: any = raw && typeof raw === 'object' ? raw : {};
  const purposes = (Array.isArray(r.purposes) ? r.purposes.map(String) : []).filter((p: string) => (CHANNEL_PURPOSES.email as string[]).includes(p) && p !== 'transactional');
  return {
    marketing: r.marketing === true,
    field: String(r.field ?? '').slice(0, 60),
    purposes: purposes.length ? purposes : ['newsletter'],
    channels: (Array.isArray(r.channels) ? r.channels : []).filter((c: unknown) => c === 'sms' || c === 'whatsapp'),
    doi: r.doi === 'on' || r.doi === 'off' ? r.doi : 'inherit',
  };
}

export const consentCaptureModule: Module = {
  name: 'consent-capture',
  register(app: App) {
    const { db } = app;
    const C = app.services.consent as Record<string, any> | undefined;
    if (!C) return;

    const pageOnly = (v: unknown) => {
      try {
        const u = new URL(String(v ?? ''), app.baseUrl());
        return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : '';
      } catch {
        return '';
      }
    };

    /** The funnel a page URL belongs to (/p/<slug> on the app's host, or its own domain) – only of this sub-account. */
    const funnelOf = (locationId: string, pageUrl: string): { id: string; name: string } | undefined => {
      try {
        const u = new URL(pageUrl, app.baseUrl());
        const m = u.pathname.match(/^\/p\/([^/]+)/);
        if (m && u.hostname === new URL(app.baseUrl()).hostname) return db.get<{ id: string; name: string }>('SELECT id, name FROM funnels WHERE slug = ? AND location_id = ?', m[1], locationId);
        if (u.hostname !== new URL(app.baseUrl()).hostname) return db.get<{ id: string; name: string }>('SELECT id, name FROM funnels WHERE domain = ? AND location_id = ?', u.hostname.toLowerCase(), locationId);
      } catch {
        /* not a URL */
      }
      return undefined;
    };

    const wantsDoi = (locationId: string, source: DoiSource, own: 'inherit' | 'on' | 'off' = 'inherit') => (own === 'on' ? true : own === 'off' ? false : !!settingsOf(app, locationId).doi.sources[source]);
    const send = (r: GrantResult) => {
      if (r.doi && r.mailQueued) dispatchDoi(app, r.doi);
      return r;
    };
    const guard = <T>(fn: () => T): T | undefined => {
      try {
        return fn();
      } catch (e) {
        // A problem with the proof must never fail the sign-up itself.
        console.error('[consent] capture:', (e as Error).message);
        return undefined;
      }
    };

    /** A form was submitted (forms.ts route): the consent field(s) of forms that collect an opt-in. */
    const captureForm = (ctx: Ctx, form: { id: string; name: string; location_id: string; fields: any[]; settings?: any }, res: { contactId?: string | null }) =>
      guard(() => {
        const s = cleanFormConsent(form.settings?.consent);
        if (!s.marketing || !res.contactId) return;
        const consentFields = (form.fields ?? []).filter((f: any) => f?.type === 'consent');
        const field = (s.field && consentFields.find((f: any) => f.name === s.field)) || consentFields[0];
        const raw = ctx.body ?? {};
        // Only an active yes counts: the consent field the visitor ticked – its label is the text that is stored.
        if (!field || !truthy(raw[field.name])) return;
        const text = String(field.label);
        const page = pageOnly(raw._page);
        const funnel = page ? funnelOf(form.location_id, page) : undefined;
        const source: SourceInfo = funnel ? { kind: 'funnel', id: funnel.id, label: `${funnel.name} (Formular „${form.name}“)` } : { kind: 'form', id: form.id, label: form.name };
        const proofUrl = cleanProofUrl(page) || `${app.baseUrl()}/f/${form.id}`;
        const contact = getContact(app, form.location_id, res.contactId);
        if (!contact) return;
        const base = { locationId: form.location_id, contactId: contact.id, source, text: { key: `form:${form.id}:${field.id ?? field.name}`, text }, proofUrl, meta: metaOf(ctx), actor: 'contact' };
        if (contact.email) send(grantConsent(app, { ...base, channel: 'email', purposes: s.purposes, doi: wantsDoi(form.location_id, funnel ? 'funnel' : 'form', s.doi) }));
        for (const ch of s.channels) if (contact.phone) grantConsent(app, { ...base, channel: ch, purposes: ['marketing'], text: { key: `form:${form.id}:${field.id ?? field.name}:${ch}`, text } });
      });

    /** Webinar registration page: consent text of the webinar, SMS reminder box. */
    const captureWebinar = (ctx: Ctx, w: { id: string; title: string; slug: string; location_id: string; settings: any }, r: { contact: Contact }, body: any) =>
      guard(() => {
        const reg = w.settings?.registration ?? {};
        const base = { locationId: w.location_id, contactId: r.contact.id, source: { kind: 'webinar', id: w.id, label: w.title }, proofUrl: `${app.baseUrl()}/w/${w.slug}`, meta: metaOf(ctx), actor: 'contact' };
        if (body?.consent === true && r.contact.email && reg.consent_text) send(grantConsent(app, { ...base, channel: 'email', purposes: ['webinar'], text: { key: `webinar:${w.id}:consent`, text: String(reg.consent_text) }, doi: wantsDoi(w.location_id, 'webinar') }));
        if (body?.sms_consent === true && r.contact.phone && reg.sms_consent_text) grantConsent(app, { ...base, channel: 'sms', purposes: ['webinar'], text: { key: `webinar:${w.id}:sms`, text: String(reg.sms_consent_text) } });
      });

    /** Community join page: the consent box of the page. */
    const captureCommunity = (ctx: Ctx, g: { id: string; name: string; location_id: string }, page: { slug: string; consent_text?: string }, contact: Contact, body: any) =>
      guard(() => {
        if (!truthy(body?.consent) || !page.consent_text?.trim() || !contact.email) return;
        send(grantConsent(app, { locationId: g.location_id, contactId: contact.id, channel: 'email', purposes: ['community'], source: { kind: 'community', id: g.id, label: g.name }, text: { key: `community:${g.id}:consent`, text: page.consent_text }, proofUrl: `${app.baseUrl()}/c/${page.slug}`, meta: metaOf(ctx), actor: 'contact', doi: wantsDoi(g.location_id, 'community') }));
      });

    /**
     * A batch of contacts that came in by import. `mode`: legacy (default – no proof, status "unbekannt/Altbestand", only a note
     * with the source), confirmed (consent proven elsewhere, `note` says how) or doi (everybody gets the confirmation mail).
     */
    const importBatch = (locationId: string, contactIds: string[], o: { mode?: string; note?: string; label?: string; purposes?: string[]; actor?: string } = {}) =>
      guard(() => {
        const mode = o.mode === 'confirmed' || o.mode === 'doi' ? o.mode : 'legacy';
        const label = o.label || 'CSV-Import';
        const source: SourceInfo = { kind: 'import', label };
        const purposes = (o.purposes?.length ? o.purposes : ['newsletter']).filter((p) => (CHANNEL_PURPOSES.email as string[]).includes(p));
        let n = 0;
        db.tx(() => {
          for (const cid of contactIds) {
            const c = getContact(app, locationId, cid);
            if (!c) continue;
            if (mode === 'legacy') {
              for (const ch of ['email', 'sms'] as const) {
                if (!(ch === 'email' ? c.email : c.phone)) continue;
                db.insert('consent_events', { id: newId(), location_id: locationId, contact_id: cid, channel: ch, purpose: '*', action: 'legacy', doi_required: 0, source_kind: 'import', source_id: '', source_label: label.slice(0, 200), text_digest: '', ip_net: '', ua_digest: '', proof_url: '', note: String(o.note || 'Import ohne Einwilligungsnachweis (Altbestand)').slice(0, 1000), actor: o.actor ?? '', created_at: now() });
              }
            } else if (c.email || mode === 'confirmed') {
              grantConsent(app, { locationId, contactId: cid, channel: 'email', purposes, source, note: o.note || (mode === 'doi' ? 'Bestätigungsanfrage per Double-Opt-in (Einwilligung steht noch aus)' : ''), actor: o.actor, doi: mode === 'doi' });
            }
            n++;
          }
        });
        return { mode, contacts: n };
      });

    /** `consent` in the body of POST /api/contacts: `true`, or { channels, purposes, doi, text, proof_url, note }. */
    const captureApi = (ctx: Ctx, locationId: string, contactId: string, spec: unknown) =>
      guard(() => {
        if (!spec) return;
        const o: any = typeof spec === 'object' ? spec : {};
        const purposes = (Array.isArray(o.purposes) && o.purposes.length ? o.purposes.map(String) : ['newsletter']).filter((p: string) => (CHANNEL_PURPOSES.email as string[]).includes(p));
        const channels: ConsentChannel[] = (Array.isArray(o.channels) && o.channels.length ? o.channels : ['email']).filter((c: unknown) => c === 'email' || c === 'sms' || c === 'whatsapp');
        const contact = getContact(app, locationId, contactId);
        if (!contact) return;
        for (const ch of channels) {
          if (!(ch === 'email' ? contact.email : contact.phone)) continue;
          send(
            grantConsent(app, {
              locationId,
              contactId,
              channel: ch,
              purposes: ch === 'email' ? purposes : ['marketing'],
              source: { kind: 'api', label: 'API' },
              text: o.text ? { key: 'api:default', text: String(o.text).slice(0, 4000) } : undefined,
              proofUrl: cleanProofUrl(o.proof_url),
              note: String(o.note ?? 'Einwilligung vom Aufrufer der API zugesichert').slice(0, 1000),
              meta: metaOf(ctx),
              actor: ctx.viaApiKey ? 'api' : (ctx.user?.id ?? ''),
              doi: ch === 'email' && (typeof o.doi === 'boolean' ? o.doi : wantsDoi(locationId, 'api')),
            }),
          );
        }
      });

    Object.assign(C, { captureForm, captureWebinar, captureCommunity, importBatch, captureApi, formConsent: cleanFormConsent, doiSources: DOI_SOURCES, purposeLabels: PURPOSE_LABEL });
  },
};
