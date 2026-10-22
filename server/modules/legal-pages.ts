import type { App, Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, html, notFound, str, type Ctx, type RawResult } from '../core/http.js';
import { publicPage } from '../core/page.js';
import { sealSettings } from '../core/secrets.js';
import { id, now, slugify } from '../core/util.js';
import {
  BLANK_PROFILE,
  DOC_KINDS,
  DOC_LABEL,
  EMPTY_FACTS,
  FORM_LABEL,
  FORMS,
  LEGAL_NOTICE,
  SERVICES,
  activeServices,
  avv,
  cleanProfile,
  datenschutz,
  docToBlocks,
  docToHtml,
  docToMarkdown,
  docToText,
  impressum,
  splitAddress,
  vvt,
  widerruf,
  type SaleKind,
  type AvvInput,
  type DocKind,
  type Facts,
  type LegalDoc,
  type LegalProfile,
} from '../services/legal-texts.js';
import { docPdf } from '../services/legal-pdf.js';
import { settingsOf as consentSettings } from '../services/consent.js';
import { cleanCmp } from '../services/cmp.js';

/**
 * Legal pages: Impressum, Datenschutzerklärung (lists the services the sub-account actually uses – Stripe, mail sender,
 * analytics found in the page code, video embeds, chat, booking …), AVV and VVT drafts from the company data, with a clear
 * "keine Rechtsberatung" notice; website funnels get their legal pages filled in instead of "Hier einfügen".
 * `app.services.legalTexts` is the small API other modules (the cloud sign-up) can reuse: `profile`, `facts`, `generate`,
 * `render`, and `register` for further document kinds. An external text provider (eRecht24) is only a configurable
 * placeholder: nothing is called unless a module registers a provider function (`legalTexts.providers`).
 */

const TRACKERS: [string, RegExp][] = [
  ['ga', /googletagmanager\.com|google-analytics\.com|\bgtag\s*\(|GTM-[A-Z0-9]+/i],
  ['google_ads', /googleadservices|['"]AW-\d|doubleclick\.net/i],
  ['meta_pixel', /connect\.facebook\.net|\bfbq\s*\(|facebook\.com\/tr\b/i],
  ['tiktok', /analytics\.tiktok\.com|\bttq\./i],
  ['linkedin', /snap\.licdn\.com|_linkedin_partner_id|\blintrk\s*\(/i],
  ['hotjar', /hotjar\.(com|io)|clarity\.ms|\bclarity\s*\(/i],
];
const EMBEDS: [string, RegExp][] = [
  ['youtube', /youtube(-nocookie)?\.com|youtu\.be/i],
  ['vimeo', /vimeo\.com/i],
  ['gmaps', /google\.[a-z.]+\/maps|maps\.googleapis\.com/i],
  ['gfonts', /fonts\.googleapis\.com|fonts\.gstatic\.com/i],
  ['other', /calendly\.com|typeform\.com|wistia\.(com|net)|loom\.com|spotify\.com|soundcloud\.com/i],
];

export const legalPagesModule: Module = {
  name: 'legal-pages',
  register(app: App) {
    const { db, router } = app;

    const safe = <T>(fn: () => T, d: T): T => {
      try {
        return fn();
      } catch {
        return d;
      }
    };
    const has = (sql: string, ...p: any[]) => safe(() => !!db.get(sql, ...p), false);

    /** The company data: what the owner saved, with the sub-account's own data (name, address, e-mail, phone, tax id) underneath. */
    const profileOf = (locationId: string): { profile: LegalProfile; prefilled: string[] } => {
      const loc = app.location(locationId)!;
      const a = splitAddress(loc.address ?? '');
      const invTax = String(loc.settings.invoices?.tax_id ?? '').trim();
      const base: Partial<LegalProfile> = {
        company: loc.name ?? '',
        street: a.street,
        zip: a.zip,
        city: a.city,
        email: loc.email ?? '',
        phone: loc.phone ?? '',
        website: /^https?:\/\//.test(loc.website ?? '') ? (loc.website as string) : '',
        vat_id: /^[A-Z]{2}[A-Z0-9]{8,12}$/i.test(invTax.replace(/\s/g, '')) ? invTax : '',
      };
      const stored = loc.settings.legal && typeof loc.settings.legal === 'object' ? loc.settings.legal : {};
      const profile = cleanProfile(stored, base);
      const prefilled = Object.entries(base).filter(([k, v]) => v && !(stored as any)[k]).map(([k]) => k);
      return { profile, prefilled };
    };

    const saveProfile = (locationId: string, patch: Record<string, any>): LegalProfile => {
      const loc = app.location(locationId)!;
      const cur = profileOf(locationId).profile;
      // The stored key never goes to the browser; the masked value coming back keeps it.
      const ext = patch.external && typeof patch.external === 'object' ? { ...cur.external, ...patch.external, apiKey: patch.external.apiKey === '••••••' ? cur.external.apiKey : patch.external.apiKey ?? cur.external.apiKey } : cur.external;
      const next = cleanProfile({ ...cur, ...patch, external: ext, overrides: patch.overrides !== undefined ? patch.overrides : cur.overrides });
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify(sealSettings(app, { ...loc.settings, legal: next }).value), locationId);
      return next;
    };

    /** What the sub-account really uses – read from the settings and the data, never guessed. */
    const factsOf = (locationId: string): Facts => {
      const loc = app.location(locationId)!;
      const f: Facts = { ...EMPTY_FACTS, calendar_sync: [], video_hosts: [], trackers: [], embeds: [] };
      const some = (table: string, where = 'location_id = ?') => has(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`, locationId);
      f.forms = some('forms');
      const consent = safe(() => consentSettings(app, locationId), undefined);
      f.newsletter = some('campaigns') || some('consent_events', "location_id = ? AND purpose IN ('newsletter','marketing')") || safe(() => db.all<{ settings: string }>('SELECT settings FROM forms WHERE location_id = ?', locationId).some((r) => JSON.parse(r.settings || '{}')?.consent?.marketing === true), false);
      f.doi = !!consent && (consent.doi.sources.form || consent.doi.sources.funnel) && f.newsletter;
      f.email_provider = String(loc.settings.email?.provider ?? '').toLowerCase();
      f.sms_provider = String(loc.settings.sms?.provider ?? '').toLowerCase();
      f.stripe = has(`SELECT 1 FROM stripe_accounts WHERE location_id = ? AND secret_key IS NOT NULL AND secret_key != ''`, locationId);
      f.invoices = some('invoices');
      f.calendars = some('calendars');
      f.calendar_sync = safe(
        () => [...new Set(db.all<{ provider: string }>(`SELECT provider FROM oauth_connections WHERE location_id = ? AND purpose LIKE '%calendar%' AND status = 'ok'`, locationId).map((r) => (/microsoft|outlook/i.test(r.provider) ? 'microsoft' : 'google')))],
        [] as string[],
      );
      f.webinars = some('webinars', "location_id = ? AND status = 'published'");
      const hosts = new Set<string>();
      for (const w of safe(() => db.all<{ video: string }>(`SELECT video FROM webinars WHERE location_id = ? AND status = 'published'`, locationId), [])) {
        const t = String(safe(() => JSON.parse(w.video || '{}'), {} as any)?.type ?? '');
        if (t === 'youtube' || t === 'vimeo') hosts.add(t);
      }
      f.chat = !!loc.settings.chat?.enabled || safe(() => db.all<{ settings: string }>('SELECT settings FROM funnels WHERE location_id = ?', locationId).some((r) => JSON.parse(r.settings || '{}')?.chat_widget), false);
      f.community = some('community_groups');
      f.courses = some('courses');
      f.telephony = has(`SELECT 1 FROM telephony_settings WHERE location_id = ? AND data != '{}'`, locationId);
      f.voice_ai = has(`SELECT 1 FROM voice_ai_calls WHERE location_id = ? LIMIT 1`, locationId);
      f.ai_provider = has(`SELECT 1 FROM ai_settings WHERE location_id = ? AND api_key IS NOT NULL AND api_key != ''`, locationId) ? (safe(() => app.services.aiProvider?.(locationId), null) ? 'openai' : 'claude') : '';
      f.attribution = loc.settings.attribution?.enabled !== false && some('funnels');
      f.cmp = safe(() => cleanCmp(loc.settings.cmp).enabled, false);
      f.whatsapp = has(`SELECT 1 FROM meta_accounts WHERE location_id = ? AND (wa_token != '' OR page_token != '')`, locationId);
      f.tickets = some('tickets');
      f.affiliates = some('affiliates');
      f.google_reviews = some('google_reviews');
      f.mailbox = some('mailboxes');
      f.email_tracking = loc.settings.email?.tracking !== false && !!app.services.instrumentEmail && (f.newsletter || some('campaigns'));
      f.employees = some('hr_employees');
      // Third-party tools and embeds in the page code (head code, HTML blocks, video blocks …).
      const code: string[] = [];
      for (const r of safe(() => db.all<{ settings: string }>('SELECT settings FROM funnels WHERE location_id = ?', locationId), [])) code.push(String(safe(() => JSON.parse(r.settings || '{}'), {} as any)?.head_code ?? ''));
      for (const r of safe(() => db.all<{ blocks: string }>('SELECT blocks FROM funnel_pages WHERE location_id = ?', locationId), [])) code.push(String(r.blocks));
      const all = code.join('\n');
      for (const [k, re] of TRACKERS) if (re.test(all)) f.trackers.push(k);
      for (const [k, re] of EMBEDS) if (re.test(all)) f.embeds.push(k);
      f.video_hosts = [...hosts];
      return f;
    };

    // --- the documents --------------------------------------------------------------------------------------------------
    const generators: Record<string, (locationId: string, opts: Record<string, any>) => LegalDoc> = {
      impressum: (loc) => impressum(profileOf(loc).profile),
      datenschutz: (loc) => datenschutz(profileOf(loc).profile, factsOf(loc)),
      vvt: (loc) => vvt(profileOf(loc).profile, factsOf(loc)),
      widerruf: (loc, o) => widerruf(profileOf(loc).profile, (['digital', 'service', 'physical'] as const).includes(o.type) ? (o.type as SaleKind) : 'digital'),
      avv: (loc, o) => {
        const party = (n: string) => ({ name: str(o[`${n}_name`] ?? o[n]?.name, 'Name', { max: 200 }), address: str(o[`${n}_address`] ?? o[n]?.address, 'Anschrift', { max: 400 }), representative: str(o[`${n}_representative`] ?? o[n]?.representative, 'Vertretung', { max: 200 }) });
        const input: Partial<AvvInput> = { controller: party('controller'), service: str(o.service, 'Leistung', { max: 600 }) || undefined };
        if (o.processor_name || o.processor?.name) input.processor = party('processor');
        return avv(profileOf(loc).profile, input, factsOf(loc));
      },
    };

    /** Provider hook for external text sources (eRecht24 …): nothing is registered by default, so nothing is ever called. */
    const providers: Record<string, (kind: string, profile: LegalProfile) => Promise<{ sections: { heading: string; body: string }[] } | undefined>> = {};

    const generate = (locationId: string, kind: string, opts: Record<string, any> = {}): LegalDoc => {
      if (!Object.hasOwn(generators, kind)) throw bad(`Unbekanntes Dokument „${kind}“`);
      return generators[kind](locationId, opts);
    };

    const render = (doc: LegalDoc, format: string, o: { notice?: boolean } = {}): { body: string | Buffer; type: string; ext: string } => {
      switch (format) {
        case 'html':
          return { body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${doc.title}</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.55;color:#111827}h2{margin-top:28px}</style></head><body>${docToHtml(doc, { notice: o.notice !== false })}</body></html>`, type: 'text/html; charset=utf-8', ext: 'html' };
        case 'md':
          return { body: docToMarkdown(doc, { notice: o.notice !== false }), type: 'text/markdown; charset=utf-8', ext: 'md' };
        case 'txt':
          return { body: docToText(doc, { notice: o.notice !== false }), type: 'text/plain; charset=utf-8', ext: 'txt' };
        case 'pdf':
          return { body: docPdf(doc, { notice: o.notice !== false }), type: 'application/pdf', ext: 'pdf' };
        default:
          throw bad('Format: pdf, html, md oder txt');
      }
    };

    app.services.legalTexts = {
      /** Company data of a sub-account (prefilled from its profile). */
      profile: (locationId: string) => profileOf(locationId).profile,
      facts: factsOf,
      generate,
      render,
      /** More document kinds (the cloud sign-up registers its terms): `register('agb', (locationId, opts) => LegalDoc)`. */
      register: (kind: string, fn: (locationId: string, opts: Record<string, any>) => LegalDoc) => void (generators[kind] = fn),
      providers,
      notice: LEGAL_NOTICE,
      kinds: () => Object.keys(generators),
      /** After a website funnel was created: its placeholder legal pages become the generated texts (only while they still hold the placeholder). */
      prefill: (locationId: string, funnelId: string) => safe(() => void applyToFunnel(locationId, funnelId, ['impressum', 'datenschutz'], false), undefined),
    };

    // --- funnel pages ---------------------------------------------------------------------------------------------------
    /** Name and one way to reach the company: the least a legal page can start from. */
    const ready = (p: LegalProfile) => !!p.company.trim() && (!!p.email || !!p.street);
    const PLACEHOLDER = /Hier deine Datenschutzerklärung einfügen|Angaben gemäß § 5 DDG\s*\n+\s*Name\s*\n\s*Straße/;
    const urlOf = (f: any, slug: string) => (f.domain ? `https://${f.domain}/${slug}` : `${app.baseUrl()}/p/${f.slug}/${slug}`);

    function applyToFunnel(locationId: string, funnelId: string, kinds: string[], overwrite: boolean) {
      const f = parseJson(db.get('SELECT * FROM funnels WHERE id = ? AND location_id = ?', funnelId, locationId), ['settings']);
      if (!f) throw notFound('Funnel nicht gefunden');
      const profile = profileOf(locationId).profile;
      // Without any company data the placeholder stays – a generated text full of gaps on a live page would be worse.
      if (!ready(profile)) return [];
      const out: { kind: string; page_id: string; url: string; created: boolean; updated: boolean }[] = [];
      for (const kind of kinds.filter((k) => k === 'impressum' || k === 'datenschutz' || k === 'widerruf')) {
        const slug = kind;
        const doc = generate(locationId, kind);
        const blocks = docToBlocks(doc).map((b) => ({ ...b, id: id(8) }));
        const page = parseJson(db.get('SELECT * FROM funnel_pages WHERE funnel_id = ? AND slug = ?', f.id, slug), ['blocks', 'seo']);
        if (!page) {
          const pos = db.get<{ n: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM funnel_pages WHERE funnel_id = ?', f.id)!.n;
          const pid = id();
          db.insert('funnel_pages', { id: pid, location_id: locationId, funnel_id: f.id, name: DOC_LABEL[kind as DocKind].replace(/ \(.*/, ''), slug, position: pos, blocks, seo: { title: doc.title }, created_at: now(), updated_at: now() });
          out.push({ kind, page_id: pid, url: urlOf(f, slug), created: true, updated: false });
        } else if (overwrite || PLACEHOLDER.test((page.blocks as any[]).map((b) => String(b?.text ?? '')).join('\n'))) {
          db.update('funnel_pages', page.id, { blocks, updated_at: now() });
          out.push({ kind, page_id: page.id, url: urlOf(f, slug), created: false, updated: true });
        }
      }
      if (out.length) {
        // The footer of the site links them (and the cookie settings when the banner is on) – only if the owner has not written one.
        const s = f.settings ?? {};
        if (!String(s.footer_text ?? '').trim()) {
          const base = f.domain ? '' : `/p/${f.slug}`;
          const footer = [`[Impressum](${base}/impressum)`, `[Datenschutz](${base}/datenschutz)`, ...(factsOf(locationId).cmp ? ['[Cookie-Einstellungen](#cookie-settings)'] : [])].join(' · ');
          db.update('funnels', f.id, { settings: { ...s, footer_text: footer }, updated_at: now() });
        }
        db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', now(), f.id);
      }
      return out;
    }

    // --- API -------------------------------------------------------------------------------------------------------------------
    const writable = (ctx: Ctx) => {
      if (ctx.scope === 'read') throw new HttpError(403, 'Dieser Schlüssel darf nur lesen');
    };

    router.get('/api/legal/profile', 'location', (ctx) => {
      const { profile, prefilled } = profileOf(ctx.locationId);
      return { profile: { ...profile, external: { ...profile.external, apiKey: profile.external.apiKey ? '••••••' : '' } }, prefilled, forms: FORMS.map((k) => ({ key: k, label: FORM_LABEL[k] })), notice: LEGAL_NOTICE };
    });
    router.put('/api/legal/profile', 'location', (ctx) => {
      writable(ctx);
      const p = saveProfile(ctx.locationId, ctx.body ?? {});
      return { profile: { ...p, external: { ...p.external, apiKey: p.external.apiKey ? '••••••' : '' } } };
    });
    router.get('/api/legal/services', 'location', (ctx) => {
      const facts = factsOf(ctx.locationId);
      const { profile } = profileOf(ctx.locationId);
      const active = new Set(activeServices(facts, profile.overrides));
      return { facts, services: SERVICES.map((s) => ({ id: s.id, label: s.label, detected: s.on(facts), override: s.id in profile.overrides ? profile.overrides[s.id] : null, active: active.has(s.id) })) };
    });
    router.post('/api/legal/generate', 'location', async (ctx) => {
      const kind = str(ctx.body?.kind, 'Dokument', { required: true });
      const doc = generate(ctx.locationId, kind, ctx.body ?? {});
      // External source (eRecht24 …): only when the owner switched it on and a module registered a provider – by default nothing is called.
      let external: { used: boolean; reason: string } = { used: false, reason: 'Keine externe Quelle eingerichtet' };
      const profile = profileOf(ctx.locationId).profile;
      const ext = profile.external;
      if (ext.enabled && (kind === 'impressum' || kind === 'datenschutz')) {
        const provider = Object.hasOwn(providers, ext.provider) ? providers[ext.provider] : undefined;
        if (!provider) external = { used: false, reason: 'Schnittstelle ist nur ein Platzhalter – es wurde nichts abgerufen, die Vorlage von HyperLevel wird verwendet' };
        else {
          try {
            const r = await provider(kind, { ...profile });
            if (r?.sections?.length) (doc.sections = r.sections), (external = { used: true, reason: 'Text von der externen Quelle' });
          } catch (e) {
            external = { used: false, reason: `Externe Quelle nicht erreichbar: ${(e as Error).message}` };
          }
        }
      }
      return { kind, label: DOC_LABEL[kind as DocKind] ?? kind, doc, html: docToHtml(doc, { notice: true }), markdown: docToMarkdown(doc, { notice: true }), missing: doc.missing, notice: LEGAL_NOTICE, external };
    });
    router.get('/api/legal/export', 'location', (ctx) => {
      const kind = str(ctx.query.get('kind'), 'Dokument', { required: true });
      const opts: Record<string, any> = {};
      for (const [k, v] of ctx.query.entries()) opts[k] = v;
      const doc = generate(ctx.locationId, kind, opts);
      const out = render(doc, String(ctx.query.get('format') ?? 'pdf'));
      return { __raw: true, status: 200, headers: { 'content-type': out.type, 'content-disposition': `attachment; filename="${slugify(kind)}.${out.ext}"`, 'cache-control': 'no-store' }, body: out.body } satisfies RawResult;
    });
    router.post('/api/legal/funnels/:id/apply', 'location', (ctx) => {
      writable(ctx);
      const kinds = Array.isArray(ctx.body?.kinds) && ctx.body.kinds.length ? ctx.body.kinds.map(String) : ['impressum', 'datenschutz'];
      if (!db.get('SELECT 1 FROM funnels WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)) throw notFound('Funnel nicht gefunden');
      if (!ready(profileOf(ctx.locationId).profile)) throw bad('Bitte erst die Firmendaten (Name, Anschrift oder E-Mail) unter „Einwilligung & Recht“ eintragen');
      return { pages: applyToFunnel(ctx.locationId, ctx.params.id, kinds, ctx.body?.overwrite === true) };
    });

    // Hosted copies for sub-accounts without a website (forms, buy pages and the checkout link to them): /legal/<sub-account>/<impressum|datenschutz|widerruf>.
    router.get('/legal/:loc/:kind', 'public', (ctx) => {
      const kind = ctx.params.kind;
      const loc = app.location(ctx.params.loc);
      if (!loc || !['impressum', 'datenschutz', 'widerruf'].includes(kind)) return html(publicPage({ title: 'Nicht gefunden', body: '<div class="wrap"><div class="card"><h1>Nicht gefunden</h1></div></div>' }), 404);
      const profile = profileOf(loc.id).profile;
      // Nothing is published before the owner entered at least the name and one way to reach them.
      if (!ready(profile)) return html(publicPage({ title: 'Noch nicht eingerichtet', body: '<div class="wrap"><div class="card"><h1>Noch nicht eingerichtet</h1><p class="muted">Diese Seite wird vom Betreiber noch vorbereitet.</p></div></div>' }), 404);
      // Anybody can ask for this page, and generating it looks at the sub-account's data: keep the result for half a minute.
      const doc = db.memo(`legal-page:${loc.id}:${kind}`, 30_000, () => {
        const d = generate(loc.id, kind, {});
        return { title: d.title, html: docToHtml(d) };
      });
      const r = html(publicPage({ title: doc.title, color: String(loc.settings?.branding?.color ?? '') || undefined, body: `<div class="wrap"><div class="card legal">${doc.html}</div></div>` }));
      r.headers['cache-control'] = 'public, max-age=300';
      r.headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'";
      return r;
    });
    app.services.legalTexts.hostedUrl = (locationId: string, kind: string) => `${app.baseUrl()}/legal/${encodeURIComponent(locationId)}/${kind}`;

    void BLANK_PROFILE;
    void DOC_KINDS;
  },
};
