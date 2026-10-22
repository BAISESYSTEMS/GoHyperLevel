import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id, now } from '../core/util.js';
import { getAccount } from '../services/channel-kit.js';
import { sigV4 } from '../services/email-providers.js';
import { MAIL_PROVIDER_KEYS, PROVIDER_LABELS, checkDomain, cleanDomain, isMailProviderKey, smtpHint, systemResolver, type DomainResult, type MailProviderKey, type ProviderFacts, type Status } from '../services/umzug-mailcheck.js';

/**
 * E-Mail-Zustellung prüfen (Einstellungen → E-Mail-Zustellung): the sending domains of a sub-account, their DNS
 * check (services/umzug-mailcheck.ts), German fix steps and "Erneut prüfen". The campaign send dialog asks
 * GET /api/mail-domains/status and warns when the sender's domain fails. Provider accounts that are already
 * connected (Resend, Brevo, Mailgun, Amazon SES) tell us the exact records their domain needs.
 * Test hooks: app.services.mailDns (resolver), app.services.mailCheckFetch (provider APIs).
 */

const FRESH_MS = 24 * 3600_000;
const MAX_DOMAINS = 20;

const providerOf = (cfg: unknown): { key: MailProviderKey; active: boolean } => {
  const p = String(cfg ?? '');
  if (isMailProviderKey(p)) return { key: p, active: true };
  // "log" sends nothing, "mailbox" is a connected Gmail/Outlook account: both are checked like SMTP.
  return { key: 'smtp', active: p === 'smtp' };
};

export const mailcheckModule: Module = {
  name: 'umzug-mailcheck',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mail_domains (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        domain TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', selector TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new', result TEXT, checked_at TEXT, created_at TEXT NOT NULL,
        UNIQUE(location_id, domain)
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const resolver = () => app.services.mailDns ?? systemResolver();
    const fetcher = (): ((url: string, init?: RequestInit) => Promise<Response>) => app.services.mailCheckFetch ?? app.services.channelFetch ?? ((u, i) => fetch(u, i));

    const settingsOf = (loc: string) => app.location(loc)?.settings?.email ?? {};
    const sender = (loc: string) => {
      const e = settingsOf(loc);
      const from = String(e.fromEmail || e.user || '').trim();
      const p = providerOf(e.provider);
      return { from_email: from, domain: cleanDomain(from.includes('@') ? from : '') ?? null, provider: p.key, active: p.active && !!from, configured_provider: String(e.provider ?? 'log'), smtp_host: String(e.host ?? '') };
    };

    // --- what a connected provider account knows about the domain -------------------------------------------------------
    async function facts(loc: string, provider: MailProviderKey, domain: string): Promise<ProviderFacts | undefined> {
      const f = fetcher();
      const t = (ms = 12_000) => AbortSignal.timeout(ms);
      try {
        if (provider === 'resend') {
          const a = getAccount(app, loc, 'mail:resend');
          if (!a?.secrets.api_key) return undefined;
          const h = { authorization: `Bearer ${a.secrets.api_key}`, accept: 'application/json' };
          const list: any = await (await f('https://api.resend.com/domains', { headers: h, signal: t() })).json();
          const d = (list.data ?? []).find((x: any) => String(x.name).toLowerCase() === domain);
          if (!d) return { note: 'Diese Domain ist in Resend noch nicht angelegt (Resend → Domains → „Add Domain“) – dort bekommst du die genauen Einträge.' };
          const full: any = await (await f(`https://api.resend.com/domains/${encodeURIComponent(d.id)}`, { headers: h, signal: t() })).json();
          const abs = (n: string) => (!n || n === '@' ? domain : n.endsWith(domain) ? n : `${n}.${domain}`);
          return {
            verified: full.status === 'verified',
            dkim: (full.records ?? []).filter((r: any) => /dkim/i.test(String(r.record))).map((r: any) => ({ fqdn: abs(String(r.name)), type: String(r.type).toUpperCase() as 'TXT' | 'CNAME', value: String(r.value) })),
            other: (full.records ?? []).filter((r: any) => !/dkim/i.test(String(r.record))).map((r: any) => ({ fqdn: abs(String(r.name)), type: String(r.type).toUpperCase() as 'TXT' | 'CNAME' | 'MX', value: String(r.value), priority: r.priority !== undefined ? Number(r.priority) : undefined, note: String(r.record) })),
          };
        }
        if (provider === 'brevo') {
          const a = getAccount(app, loc, 'mail:brevo');
          if (!a?.secrets.api_key) return undefined;
          const r = await f(`https://api.brevo.com/v3/senders/domains/${encodeURIComponent(domain)}`, { headers: { 'api-key': a.secrets.api_key, accept: 'application/json' }, signal: t() });
          if (r.status === 404) return { note: 'Diese Domain ist in Brevo noch nicht angelegt (Brevo → Absender, Domains → „Domain hinzufügen“).' };
          const j: any = await r.json();
          const recs = Object.values(j.dns_records ?? {}).filter((x: any) => x && typeof x === 'object' && x.value) as any[];
          const abs = (n: string) => (!n || n === '@' ? domain : n.endsWith(domain) ? n : `${n}.${domain}`);
          return {
            verified: !!(j.verified ?? j.authenticated),
            dkim: recs.filter((x) => /_domainkey/i.test(String(x.host_name))).map((x) => ({ fqdn: abs(String(x.host_name)), type: String(x.type).toUpperCase() as 'TXT' | 'CNAME', value: String(x.value) })),
            other: recs.filter((x) => !/_domainkey/i.test(String(x.host_name)) && !/dmarc/i.test(String(x.host_name))).map((x) => ({ fqdn: abs(String(x.host_name)), type: String(x.type).toUpperCase() as 'TXT' | 'CNAME', value: String(x.value), note: 'Brevo' })),
          };
        }
        if (provider === 'mailgun') {
          const a = getAccount(app, loc, 'mail:mailgun');
          if (!a?.secrets.api_key || !a.config.domain) return undefined;
          const host = a.config.region === 'us' ? 'api.mailgun.net' : 'api.eu.mailgun.net';
          const r = await f(`https://${host}/v3/domains/${encodeURIComponent(a.config.domain)}`, { headers: { authorization: `Basic ${Buffer.from(`api:${a.secrets.api_key}`).toString('base64')}` }, signal: t() });
          if (!r.ok) return { note: `Mailgun-Domain ${a.config.domain} konnte nicht gelesen werden (${r.status}).` };
          const j: any = await r.json();
          const send: any[] = j.sending_dns_records ?? [];
          return {
            verified: j.domain?.state === 'active',
            dkim: send.filter((x) => /_domainkey/i.test(String(x.name))).map((x) => ({ fqdn: String(x.name).toLowerCase(), type: String(x.record_type).toUpperCase() as 'TXT' | 'CNAME', value: String(x.value) })),
            other: send.filter((x) => !/_domainkey/i.test(String(x.name)) && String(x.record_type).toUpperCase() !== 'TXT').map((x) => ({ fqdn: String(x.name).toLowerCase(), type: String(x.record_type).toUpperCase() as 'CNAME' | 'MX', value: String(x.value), priority: x.priority !== undefined ? Number(x.priority) : undefined, note: 'Mailgun' })),
            note: a.config.domain !== domain ? `Mailgun sendet über ${a.config.domain} – die Einträge liegen dort.` : undefined,
          };
        }
        if (provider === 'ses') {
          const a = getAccount(app, loc, 'mail:ses');
          if (!a?.secrets.access_key_id || !a.config.region) return undefined;
          const url = `https://email.${a.config.region}.amazonaws.com/v2/email/identities/${encodeURIComponent(domain)}`;
          const headers = sigV4({ method: 'GET', url, body: '', region: a.config.region, service: 'ses', accessKeyId: a.secrets.access_key_id, secretAccessKey: a.secrets.secret_access_key });
          delete headers.host;
          const r = await f(url, { headers, signal: t() });
          if (r.status === 404) return { note: 'Diese Domain ist in Amazon SES noch nicht als Identität angelegt (SES → Verified identities → „Create identity“).' };
          const j: any = await r.json();
          const tokens: string[] = j.DkimAttributes?.Tokens ?? [];
          const out: ProviderFacts = { verified: !!j.VerifiedForSendingStatus, dkim: tokens.map((tk) => ({ fqdn: `${tk}._domainkey.${domain}`, type: 'CNAME' as const, value: `${tk}.dkim.amazonses.com` })), other: [] };
          const mf = j.MailFromAttributes?.MailFromDomain;
          if (mf) out.other = [{ fqdn: String(mf), type: 'MX', value: `feedback-smtp.${a.config.region}.amazonses.com`, priority: 10, note: 'SES-Rückweg-Domain' }];
          if (!tokens.length) out.note = 'SES liefert keine Easy-DKIM-Einträge für diese Identität (eigener DKIM-Schlüssel?) – trage den Selektor selbst ein.';
          return out;
        }
      } catch (e) {
        return { note: `Anbieter-Abfrage nicht möglich: ${(e as Error).message}` };
      }
      return undefined;
    }

    // --- rows ---------------------------------------------------------------------------------------------------------------------------
    const row = (loc: string, rid: string) => db.get<any>('SELECT * FROM mail_domains WHERE id = ? AND location_id = ?', rid, loc);
    const parse = (r: any): DomainResult | null => {
      try {
        return r?.result ? JSON.parse(r.result) : null;
      } catch {
        return null;
      }
    };
    const brief = (r: any) => {
      const res = parse(r);
      return { id: r.id, domain: r.domain, provider: r.provider, provider_label: PROVIDER_LABELS[r.provider as MailProviderKey] ?? r.provider, selector: r.selector, status: (r.status as Status | 'new') ?? 'new', checked_at: r.checked_at, summary: res?.summary ?? 'Noch nicht geprüft', checks: (res?.checks ?? []).map((c) => ({ key: c.key, label: c.label, status: c.status, summary: c.summary, optional: !!c.optional })) };
    };
    const full = (r: any) => ({ ...brief(r), result: parse(r) });

    const hits = new Map<string, number[]>();
    const throttle = (loc: string) => {
      const t = Date.now();
      const list = (hits.get(loc) ?? []).filter((x) => t - x < 3_600_000);
      if (list.length >= 40) throw new HttpError(429, 'Zu viele Prüfungen – bitte in einer Weile wieder versuchen');
      hits.set(loc, [...list, t]);
    };

    async function runCheck(loc: string, r: any): Promise<DomainResult> {
      if (r.checked_at && Date.now() - new Date(r.checked_at).getTime() < 3000) throw new HttpError(429, 'Gerade erst geprüft – bitte ein paar Sekunden warten');
      throttle(loc);
      const s = sender(loc);
      const provider = isMailProviderKey(r.provider) ? r.provider : s.provider;
      const res = await checkDomain(resolver(), { domain: r.domain, provider, selector: r.selector, smtpHost: provider === 'smtp' ? s.smtp_host : undefined, facts: await facts(loc, provider, r.domain) });
      db.update('mail_domains', r.id, { status: res.status, result: res, checked_at: res.checked_at });
      return res;
    }

    function ensureDomain(loc: string, domain: string, provider = '', selector = ''): any {
      const have = db.get<any>('SELECT * FROM mail_domains WHERE location_id = ? AND domain = ?', loc, domain);
      if (have) return have;
      if (Number(db.get<{ n: number }>('SELECT COUNT(*) n FROM mail_domains WHERE location_id = ?', loc)?.n ?? 0) >= MAX_DOMAINS) throw bad(`Höchstens ${MAX_DOMAINS} Domains je Sub-Account`);
      const rid = id();
      db.insert('mail_domains', { id: rid, location_id: loc, domain, provider, selector, status: 'new', created_at: now() });
      return db.get<any>('SELECT * FROM mail_domains WHERE id = ?', rid);
    }

    // --- routes ------------------------------------------------------------------------------------------------------------------------------
    router.get('/api/mail-domains', 'location', (ctx) => {
      const s = sender(ctx.locationId);
      const rows = db.all<any>('SELECT * FROM mail_domains WHERE location_id = ? ORDER BY domain', ctx.locationId);
      return {
        domains: rows.map(brief),
        sender: { from_email: s.from_email, domain: s.domain, provider: s.provider, provider_label: PROVIDER_LABELS[s.provider], active: s.active, added: !!s.domain && rows.some((r) => r.domain === s.domain), configured_provider: s.configured_provider },
        providers: MAIL_PROVIDER_KEYS.map((k) => ({ key: k, label: PROVIDER_LABELS[k], configured: k === 'smtp' ? s.configured_provider === 'smtp' : !!getAccount(app, ctx.locationId, `mail:${k}`)?.enabled })),
        smtp_hint: smtpHint(s.smtp_host)?.name ?? null,
        rules: [
          { label: 'SPF und DKIM sind eingerichtet (am besten beides)', key: 'auth' },
          { label: 'DMARC-Eintrag vorhanden (ab etwa 5.000 Mails am Tag Pflicht bei Gmail und Yahoo)', key: 'dmarc' },
          { label: 'One-Click-Abmeldung im Mail-Kopf – HyperLevel setzt sie bei Kampagnen und Automationen automatisch', key: 'unsub' },
          { label: 'Spam-Beschwerden unter 0,3 %: nur an Leute senden, die zugestimmt haben', key: 'spam' },
        ],
      };
    });

    /** For the campaign send dialog: the verdict for the sender's domain (checks it first when nothing is known or it is old). */
    router.get('/api/mail-domains/status', 'location', async (ctx) => {
      const s = sender(ctx.locationId);
      if (!s.from_email || !s.domain) return { status: 'none', domain: null, summary: 'Es ist noch keine Absender-Adresse eingestellt (Einstellungen → E-Mail & SMS).' };
      if (!s.active) return { status: 'log', domain: s.domain, summary: 'Der Versand ist im Testmodus – es wird nichts verschickt.' };
      let r = db.get<any>('SELECT * FROM mail_domains WHERE location_id = ? AND domain = ?', ctx.locationId, s.domain);
      const stale = !r?.checked_at || Date.now() - new Date(r.checked_at).getTime() > FRESH_MS;
      if (stale && ctx.query.get('refresh') === '1') {
        r = r ?? ensureDomain(ctx.locationId, s.domain);
        try {
          await runCheck(ctx.locationId, r);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 429)) throw e;
        }
        r = row(ctx.locationId, r.id);
      }
      if (!r || !r.checked_at) return { status: 'new', domain: s.domain, summary: 'Die Domain wurde noch nicht geprüft.' };
      const res = parse(r);
      const issues = (res?.checks ?? []).filter((c) => c.status !== 'ok' && !c.optional).map((c) => ({ key: c.key, label: c.label, status: c.status, summary: c.summary }));
      return { status: r.status, domain: s.domain, provider: s.provider, summary: res?.summary ?? '', issues, checked_at: r.checked_at, stale };
    });

    router.post('/api/mail-domains', 'location', (ctx) => {
      const domain = cleanDomain(ctx.body?.domain);
      if (!domain) throw bad('Das ist keine gültige Domain – z. B. meinefirma.de');
      const provider = ctx.body?.provider ? (isMailProviderKey(ctx.body.provider) ? ctx.body.provider : (() => { throw bad('Unbekannter Anbieter'); })()) : '';
      const selector = str(ctx.body?.selector, 'Selektor', { max: 80 }).toLowerCase().replace(/\._domainkey.*$/, '');
      if (selector && !/^[a-z0-9]([a-z0-9._-]{0,78}[a-z0-9])?$/.test(selector)) throw bad('Der Selektor darf nur Buchstaben, Zahlen, Punkt, Bindestrich und Unterstrich enthalten');
      if (db.get('SELECT 1 FROM mail_domains WHERE location_id = ? AND domain = ?', ctx.locationId, domain)) throw bad('Diese Domain ist schon in der Liste');
      return full(ensureDomain(ctx.locationId, domain, provider, selector));
    });
    router.get('/api/mail-domains/:id', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound();
      return full(r);
    });
    router.patch('/api/mail-domains/:id', 'location', (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound();
      const patch: Record<string, any> = {};
      if (ctx.body?.provider !== undefined) {
        if (ctx.body.provider && !isMailProviderKey(ctx.body.provider)) throw bad('Unbekannter Anbieter');
        patch.provider = ctx.body.provider || '';
      }
      if (ctx.body?.selector !== undefined) {
        const selector = str(ctx.body.selector, 'Selektor', { max: 80 }).toLowerCase().replace(/\._domainkey.*$/, '');
        if (selector && !/^[a-z0-9]([a-z0-9._-]{0,78}[a-z0-9])?$/.test(selector)) throw bad('Der Selektor darf nur Buchstaben, Zahlen, Punkt, Bindestrich und Unterstrich enthalten');
        patch.selector = selector;
      }
      // A changed setup invalidates the last verdict.
      if (Object.keys(patch).length) db.update('mail_domains', r.id, { ...patch, status: 'new', result: null, checked_at: null });
      return full(row(ctx.locationId, r.id));
    });
    router.delete('/api/mail-domains/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM mail_domains WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      return { ok: true };
    });
    /** Adds the domain if needed and checks it – the one call the MCP tool and the "Jetzt prüfen" button of the send dialog use. Without a domain: the sender's. */
    router.post('/api/mail-domains/check', 'location', async (ctx) => {
      const d = ctx.body?.domain ? cleanDomain(ctx.body.domain) : sender(ctx.locationId).domain;
      if (!d) throw bad(ctx.body?.domain ? 'Das ist keine gültige Domain' : 'Es ist noch keine Absender-Adresse eingestellt (Einstellungen → E-Mail & SMS)');
      const r = ensureDomain(ctx.locationId, d);
      await runCheck(ctx.locationId, r);
      return full(row(ctx.locationId, r.id));
    });
    router.post('/api/mail-domains/:id/check', 'location', async (ctx) => {
      const r = row(ctx.locationId, ctx.params.id);
      if (!r) throw notFound();
      await runCheck(ctx.locationId, r);
      return full(row(ctx.locationId, r.id));
    });

  },
};

