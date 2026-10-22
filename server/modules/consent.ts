import type { App, Module } from '../core/app.js';
import { HttpError, bad, notFound, num, str, text, type Ctx, type RawResult } from '../core/http.js';
import { getContact } from '../services/contacts.js';
import {
  ACTIONS,
  CHANNELS,
  CHANNEL_LABEL,
  CHANNEL_PURPOSES,
  PURPOSES,
  PURPOSE_LABEL,
  STATUS_LABEL,
  deriveAll,
  type ConsentChannel,
} from '../services/consent-model.js';
import { buildProof, proofCsv, proofPdf } from '../services/consent-proof.js';
import {
  allowMarketing,
  allowMarketingMany,
  cleanProofUrl,
  confirmUrl,
  dispatchDoi,
  doiOf,
  ensureText,
  eventsOf,
  gate,
  getDoi,
  grantConsent,
  judge,
  metaOf,
  prefsUrl,
  resetConsent,
  revokeConsent,
  runDoiTick,
  saveSettings,
  settingsOf,
  statusOf,
  sendDoiMail,
  type SourceInfo,
} from '../services/consent.js';
import { registerTriggers, type FieldDef, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Consent ledger (Einwilligung): who agreed to what, when, where and with which text – per contact, channel and purpose –
 * with a derived status (unknown / pending / confirmed / revoked), Double-Opt-in, the send gate for campaigns and workflows,
 * the proof export (CSV/PDF, also in the privacy export) and the workflow triggers `consent.confirmed` / `consent.revoked`.
 * Logic: services/consent*.ts. Capture hooks: consent-capture.ts; public pages (confirmation link, preference centre): consent-pages.ts.
 * Legal pages, the cookie banner and the checkout rules are their own modules (legal-pages, consent-banner, checkout-law).
 */

const CHANNEL_FIELD: FieldDef = { key: 'channel', label: 'Kanal', type: 'select', options: [['', 'Jeder'], ...CHANNELS.map((c) => [c, CHANNEL_LABEL[c]] as [string, string])] };
const PURPOSE_FIELD: FieldDef = { key: 'purpose', label: 'Zweck', type: 'select', options: [['', 'Jeder'], ...PURPOSES.filter((p) => p !== 'transactional').map((p) => [p, PURPOSE_LABEL[p]] as [string, string])] };
const sample = { channel: 'email', purposes: ['newsletter'], source: 'form', doi: true };

export const CONSENT_TRIGGERS: TriggerMeta[] = [
  {
    type: 'consent.confirmed',
    label: 'Einwilligung bestätigt',
    category: 'contact',
    summary: 'Ein Kontakt hat eingewilligt – bei Double-Opt-in erst nach dem Klick auf den Bestätigungslink.',
    doc: 'Startet, sobald eine Einwilligung gültig ist: sofort bei einem Formular ohne Double-Opt-in, sonst erst nach der Bestätigung. {{event.channel}}, {{event.purposes}} (Liste), {{event.source}} (form, funnel, webinar, community, doi, preferences, manual …) und {{event.doi}} (true bei Double-Opt-in) stehen zur Verfügung. Typisch: Willkommens-E-Mail-Serie erst jetzt starten, Tag „newsletter“ setzen, Lead-Magnet ausliefern.',
    fields: [CHANNEL_FIELD, PURPOSE_FIELD],
    sample,
    keywords: 'einwilligung double opt-in doi bestätigt newsletter dsgvo',
  },
  {
    type: 'consent.revoked',
    label: 'Einwilligung widerrufen',
    category: 'contact',
    summary: 'Ein Kontakt widerruft – über den Abmeldelink, die Einstellungsseite oder das Team.',
    doc: 'Startet bei jedem Widerruf. {{event.channel}} ist ein Kanal oder „all“, {{event.purposes}} die Zwecke (leer = alle), {{event.source}} sagt wie (unsubscribe, preferences, manual …). Typisch: Team informieren, Tag „abgemeldet“ setzen. Weitere Werbe-Nachrichten werden ohnehin nicht mehr zugestellt.',
    fields: [CHANNEL_FIELD],
    sample: { channel: 'all', purposes: [], source: 'unsubscribe' },
    keywords: 'widerruf abmeldung unsubscribe dsgvo einwilligung',
  },
];

const TOOLS: Tool[] = [
  {
    name: 'ghl_contact_consent',
    title: 'Einwilligungsnachweis eines Kontakts',
    description: 'Consent-Ledger eines Kontakts: aktueller Status je Kanal (E-Mail, SMS, WhatsApp, Telefon, Tracking), alle Ereignisse mit Quelle, Zeitpunkt, Einwilligungstext (Version), IP-Netz, offene Double-Opt-in-Bestätigungen. Nur lesen.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, contact_id: { type: 'string' } }, required: ['contact_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/contacts/${encodeURIComponent(a.contact_id)}/consent/proof`, { location: a.location_id }),
  },
];

const KEY = /^[a-z0-9][a-z0-9:_.\-/]{0,119}$/i;

export const consentModule: Module = {
  name: 'consent',
  migrations: [
    [
      '001-ledger',
      `
      CREATE TABLE consent_texts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        key TEXT NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, text_digest TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(location_id, key, version)
      );
      CREATE TABLE consent_events (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, purpose TEXT NOT NULL, action TEXT NOT NULL,
        doi_required INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
        source_kind TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', source_label TEXT NOT NULL DEFAULT '',
        text_id TEXT, text_version INTEGER, text_digest TEXT NOT NULL DEFAULT '',
        ip_net TEXT NOT NULL DEFAULT '', ua_digest TEXT NOT NULL DEFAULT '',
        proof_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '',
        doi_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX consent_events_contact ON consent_events(contact_id, channel, created_at);
      CREATE INDEX consent_events_loc ON consent_events(location_id, created_at);
      CREATE TABLE consent_doi (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, purposes TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', email TEXT NOT NULL DEFAULT '',
        source_kind TEXT NOT NULL DEFAULT '', source_id TEXT NOT NULL DEFAULT '', source_label TEXT NOT NULL DEFAULT '',
        text_id TEXT, text_version INTEGER, proof_url TEXT NOT NULL DEFAULT '',
        ip_net TEXT NOT NULL DEFAULT '', ua_digest TEXT NOT NULL DEFAULT '',
        requested_at TEXT NOT NULL, expires_at TEXT NOT NULL, mailed_at TEXT, mail_attempts INTEGER NOT NULL DEFAULT 0,
        reminded_at TEXT, confirmed_at TEXT
      );
      CREATE INDEX consent_doi_contact ON consent_doi(contact_id, status);
      CREATE INDEX consent_doi_due ON consent_doi(status, expires_at);
      `,
    ],
    // What kind of message went out and on which basis (confirmed / legacy / exempt / override / blocked) – shown in the proof.
    ['002-message-basis', `ALTER TABLE messages ADD COLUMN purpose TEXT NOT NULL DEFAULT ''; ALTER TABLE messages ADD COLUMN consent_basis TEXT NOT NULL DEFAULT '';`],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, CONSENT_TRIGGERS);
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'consent.confirmed': (c: any, d: any) => (!c.channel || c.channel === d.channel) && (!c.purpose || (d.purposes ?? []).includes(c.purpose)),
      'consent.revoked': (c: any, d: any) => !c.channel || c.channel === d.channel || d.channel === 'all',
    };

    // The hooks other modules call (messaging, campaigns, forms, imports, webinars, community, unsubscribe).
    app.services.consentGate = (i: Parameters<typeof gate>[1]) => gate(app, i);
    app.services.consent = {
      settings: (loc: string) => settingsOf(app, loc),
      status: (loc: string, contactId: string) => statusOf(app, loc, contactId),
      grant: (i: Parameters<typeof grantConsent>[1]) => grantConsent(app, i),
      revoke: (i: Parameters<typeof revokeConsent>[1]) => revokeConsent(app, i),
      judge: (i: Parameters<typeof judge>[1]) => judge(app, i),
      allowMarketing: (loc: string, contact: { id: string; dnd: number }, channel: string) => allowMarketing(app, loc, contact, channel),
      allowMarketingMany: (loc: string, contacts: { id: string; dnd: number }[], channel: string) => allowMarketingMany(app, loc, contacts, channel),
      ensureText: (loc: string, key: string, body: string) => ensureText(app, loc, key, body),
      metaOf,
      prefsUrl: (contactId: string) => prefsUrl(app, contactId),
      proof: (loc: string, contactId: string) => buildProof(app, loc, contactId),
      /** The unsubscribe link was used (contacts module): DND is set, the ledger records the withdrawal with the browser's proof data. */
      unsubscribed: (ctx: Ctx | undefined, loc: string, contactId: string) =>
        void revokeConsent(app, { locationId: loc, contactId, channel: 'all', source: { kind: 'unsubscribe', label: 'Abmeldelink in einer E-Mail' }, meta: metaOf(ctx), actor: 'contact' }),
    };

    // "Nicht stören" changed by hand (contact page, bulk action, workflow step): the ledger keeps a line for it.
    app.events.on('contact.updated', (e) => {
      const d = e.data ?? {};
      if (!Array.isArray(d.changed) || !d.changed.includes('dnd') || !!d.previous?.dnd === !!d.contact?.dnd || !d.contactId) return;
      try {
        if (d.contact?.dnd) revokeConsent(app, { locationId: e.locationId, contactId: d.contactId, channel: 'all', source: { kind: 'manual', label: 'Nicht stören' }, note: '„Nicht stören“ gesetzt', actor: 'team' });
        else resetConsent(app, e.locationId, d.contactId, { kind: 'manual', label: 'Nicht stören' }, { actor: 'team', note: '„Nicht stören“ aufgehoben' });
      } catch (err) {
        console.error('[consent] dnd:', (err as Error).message);
      }
    });

    // The mails that are due (first mails, reminders, expiry) go out of the regular tick.
    app.onTick(async () => void (await runDoiTick(app)));
    app.services.consent.tick = (limit?: number) => runDoiTick(app, limit);

    // Part of the privacy export (Art. 15): the proof with texts and derived status, next to the raw rows the generic export lists.
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_app: App, loc: string, contact: { id: string }) => {
        const p = buildProof(app, loc, contact.id);
        return p.events.length || p.doi.length ? { 'Einwilligungsnachweis (Zusammenfassung)': [{ status: p.status, events: p.events, doi: p.doi, messages: p.messages }] } : {};
      },
    ];

    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };
    const contactOf = (ctx: Ctx) => {
      const c = getContact(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Kontakt nicht gefunden');
      return c;
    };

    // --- settings -------------------------------------------------------------------------------------------------------
    router.get('/api/consent/settings', 'location', (ctx) => ({ settings: settingsOf(app, ctx.locationId), channels: CHANNELS.map((c) => ({ key: c, label: CHANNEL_LABEL[c], purposes: CHANNEL_PURPOSES[c].map((p) => ({ key: p, label: PURPOSE_LABEL[p] })) })) }));
    router.put('/api/consent/settings', 'location', (ctx) => {
      writable(ctx);
      const b = ctx.body ?? {};
      if (b.policy !== undefined && b.policy !== 'legacy' && b.policy !== 'confirmed') throw bad('Versandregel: „legacy“ oder „confirmed“');
      return { settings: saveSettings(app, ctx.locationId, b) };
    });

    // --- overview and log ------------------------------------------------------------------------------------------------
    router.get('/api/consent/overview', 'location', (ctx) =>
      db.memo(`consent-overview:${ctx.locationId}`, 15_000, () => {
        const byContact = new Map<string, any[]>();
        for (const e of db.all<any>(`SELECT id, contact_id, channel, purpose, action, doi_required, expires_at, created_at FROM consent_events WHERE location_id = ? AND channel IN ('email', 'sms') ORDER BY created_at, rowid`, ctx.locationId)) {
          const l = byContact.get(e.contact_id) ?? [];
          l.push(e);
          byContact.set(e.contact_id, l);
        }
        const out: Record<string, Record<string, number>> = {};
        for (const channel of ['email', 'sms'] as const) {
          const n = { confirmed: 0, pending: 0, revoked: 0, unknown_legacy: 0, unknown: 0, total: 0 };
          for (const c of db.all<{ id: string; dnd: number }>(`SELECT id, dnd FROM contacts WHERE location_id = ? AND ${channel === 'email' ? 'email' : 'phone'} != ''`, ctx.locationId)) {
            const s = deriveAll(byContact.get(c.id) ?? [], { dnd: !!c.dnd })[channel];
            n.total++;
            if (s.status === 'unknown') n[s.legacy ? 'unknown_legacy' : 'unknown']++;
            else n[s.status]++;
          }
          out[channel] = n;
        }
        const doi = db.get<{ pending: number }>(`SELECT COUNT(*) pending FROM consent_doi WHERE location_id = ? AND status = 'pending' AND expires_at > ?`, ctx.locationId, new Date().toISOString());
        return { ...out, doi_pending: Number(doi?.pending ?? 0), policy: settingsOf(app, ctx.locationId).policy };
      }),
    );

    router.get('/api/consent/log', 'location', (ctx) => {
      const limit = Math.min(Math.max(num(ctx.query.get('limit'), 100), 1), 500);
      const action = ctx.query.get('action');
      const channel = ctx.query.get('channel');
      return db.all(
        `SELECT e.id, e.contact_id, e.channel, e.purpose, e.action, e.doi_required, e.source_kind, e.source_label, e.text_version, e.ip_net, e.note, e.created_at, c.first_name, c.last_name, c.email
         FROM consent_events e LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE e.location_id = ?${action && (ACTIONS as readonly string[]).includes(action) ? ' AND e.action = ?' : ''}${channel && (CHANNELS as readonly string[]).includes(channel) ? ' AND e.channel = ?' : ''}
         ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
        ctx.locationId,
        ...(action && (ACTIONS as readonly string[]).includes(action) ? [action] : []),
        ...(channel && (CHANNELS as readonly string[]).includes(channel) ? [channel] : []),
        limit,
      );
    });

    // --- consent texts (versioned) --------------------------------------------------------------------------------------
    router.get('/api/consent/texts', 'location', (ctx) => db.all('SELECT id, key, version, text, text_digest, created_at FROM consent_texts WHERE location_id = ? ORDER BY key, version DESC LIMIT 500', ctx.locationId));
    router.post('/api/consent/texts', 'location', (ctx) => {
      writable(ctx);
      const key = str(ctx.body?.key, 'Schlüssel', { required: true, max: 120 });
      if (!KEY.test(key)) throw bad('Schlüssel: Buchstaben, Ziffern und : _ . - /');
      return ensureText(app, ctx.locationId, key, str(ctx.body?.text, 'Text', { required: true, max: 4000 }));
    });

    // --- one contact ----------------------------------------------------------------------------------------------------
    const view = (ctx: Ctx) => {
      const c = contactOf(ctx);
      const events = eventsOf(app, c.id);
      const state = deriveAll(events, { dnd: !!c.dnd });
      const texts = new Map<string, string>();
      for (const e of events) if (e.text_id && !texts.has(e.text_id)) texts.set(e.text_id, db.get<{ text: string }>('SELECT text FROM consent_texts WHERE id = ?', e.text_id)?.text ?? '');
      const doi = doiOf(app, c.id).map((d) => ({ ...d, link: d.status === 'pending' ? confirmUrl(app, d) : undefined }));
      return {
        contact: { id: c.id, dnd: !!c.dnd, email: c.email, phone: c.phone, source: c.source },
        policy: settingsOf(app, ctx.locationId).policy,
        channels: Object.fromEntries(CHANNELS.map((ch) => [ch, { ...state[ch], label: STATUS_LABEL[state[ch].status], channel_label: CHANNEL_LABEL[ch] }])),
        events: events
          .slice()
          .reverse()
          .slice(0, 300)
          .map((e) => ({ id: e.id, channel: e.channel, purpose: e.purpose, action: e.action, doi_required: !!e.doi_required, source_kind: e.source_kind, source_label: e.source_label, text: e.text_id ? texts.get(e.text_id) : '', text_version: e.text_version, ip_net: e.ip_net, proof_url: e.proof_url, note: e.note, actor: e.actor, created_at: e.created_at })),
        doi,
        preferences_url: prefsUrl(app, c.id),
      };
    };
    router.get('/api/contacts/:id/consent', 'location', view);
    router.get('/api/contacts/:id/consent/proof', 'location', (ctx) => buildProof(app, ctx.locationId, contactOf(ctx).id));

    router.post('/api/contacts/:id/consent', 'location', (ctx) => {
      writable(ctx);
      const c = contactOf(ctx);
      const b = ctx.body ?? {};
      const action = String(b.action ?? '');
      const channel = String(b.channel ?? 'email');
      const purposes = Array.isArray(b.purposes) ? b.purposes.map(String) : b.purpose ? [String(b.purpose)] : [];
      const source: SourceInfo = ctx.viaApiKey ? { kind: 'api', label: 'API' } : { kind: 'manual', label: ctx.user?.name || ctx.user?.email || 'Team' };
      const actor = ctx.user?.id ?? (ctx.viaApiKey ? 'api' : 'team');
      if (action === 'reset') {
        db.run('UPDATE contacts SET dnd = 0, updated_at = ? WHERE id = ?', new Date().toISOString(), c.id);
        resetConsent(app, ctx.locationId, c.id, source, { actor, note: str(b.note, 'Notiz', { max: 1000 }) });
        return view(ctx);
      }
      if (action === 'revoked') {
        if (channel !== 'all' && !(CHANNELS as readonly string[]).includes(channel)) throw bad('Unbekannter Kanal');
        revokeConsent(app, { locationId: ctx.locationId, contactId: c.id, channel: channel as ConsentChannel | 'all', purposes, source, note: str(b.note, 'Notiz', { max: 1000 }), actor });
        return view(ctx);
      }
      if (action !== 'granted') throw bad('Aktion: granted, revoked oder reset');
      if (!(CHANNELS as readonly string[]).includes(channel)) throw bad('Unbekannter Kanal');
      const note = str(b.note, 'Nachweis', { max: 1000 });
      const doi = !!b.doi;
      if (!doi && !note && !b.text) throw bad('Bitte den Nachweis angeben (z. B. „telefonisch am 12.03. zugestimmt“) – ohne Nachweis ist eine Einwilligung wertlos');
      const r = grantConsent(app, {
        locationId: ctx.locationId,
        contactId: c.id,
        channel: channel as ConsentChannel,
        purposes: purposes.length ? purposes : [channel === 'email' ? 'newsletter' : 'marketing'],
        source,
        text: b.text ? { key: `manual:${channel}`, text: str(b.text, 'Text', { max: 4000 }) } : undefined,
        proofUrl: cleanProofUrl(b.proof_url),
        note: doi && !note ? 'Bestätigungsanfrage per Double-Opt-in (Einwilligung steht noch aus)' : note,
        actor,
        doi,
        clearDnd: !!b.clear_dnd,
      });
      if (r.doi && r.mailQueued) dispatchDoi(app, r.doi);
      return view(ctx);
    });

    /** Sends the confirmation mail of an open request again (or starts one). */
    router.post('/api/contacts/:id/consent/doi', 'location', async (ctx) => {
      writable(ctx);
      const c = contactOf(ctx);
      const doiId = String(ctx.body?.doi_id ?? '');
      let d = doiId ? getDoi(app, doiId) : undefined;
      if (d && (d.contact_id !== c.id || d.location_id !== ctx.locationId)) throw notFound();
      if (!d) {
        const purposes = Array.isArray(ctx.body?.purposes) && ctx.body.purposes.length ? ctx.body.purposes.map(String) : ['newsletter'];
        const r = grantConsent(app, { locationId: ctx.locationId, contactId: c.id, channel: 'email', purposes, source: { kind: 'manual', label: ctx.user?.name || 'Team' }, note: 'Bestätigungsanfrage per Double-Opt-in (Einwilligung steht noch aus)', actor: ctx.user?.id ?? 'team', doi: true });
        d = r.doi!;
      }
      if (d.status !== 'pending') throw bad('Diese Bestätigung ist nicht mehr offen');
      const ok = await sendDoiMail(app, d);
      if (!ok) throw bad('Die E-Mail konnte nicht gesendet werden (Kontakt ohne E-Mail-Adresse oder Versand nicht eingerichtet)');
      db.run('UPDATE consent_doi SET mailed_at = ? WHERE id = ?', new Date().toISOString(), d.id);
      return view(ctx);
    });

    const download = (ctx: Ctx, kind: 'csv' | 'pdf'): RawResult => {
      const c = contactOf(ctx);
      const proof = buildProof(app, ctx.locationId, c.id);
      const name = `einwilligung-${c.id.replace(/[^\w-]/g, '')}`;
      if (kind === 'csv') {
        const r = text(proofCsv(proof), 'text/csv; charset=utf-8');
        r.headers['content-disposition'] = `attachment; filename="${name}.csv"`;
        r.headers['cache-control'] = 'no-store';
        return r;
      }
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${name}.pdf"`, 'cache-control': 'no-store' }, body: proofPdf(proof) };
    };
    router.get('/api/contacts/:id/consent/export.csv', 'location', (ctx) => download(ctx, 'csv'));
    router.get('/api/contacts/:id/consent/export.pdf', 'location', (ctx) => download(ctx, 'pdf'));

  },
};
