import type { App, LocationRow, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { applyDelivery, channelFetch, deleteAccount, firstSeen, forgetSeen, getAccount, header, noteError, noteWebhook, safeEqual, saveAccount, secretsSet, type ChannelAccount } from '../services/channel-kit.js';
import { MAIL_PROVIDERS, isMailProvider, parseBrevo, parseMailgun, parseMultipart, parsePostmark, parseResend, parseSesMessage, sendMail, testMail, verifyMailgun, verifySns, verifySvix, isSnsHost, type MailProvider, type MailWebhook } from '../services/email-providers.js';
import { receiveMessage, type OutMail } from '../services/messaging.js';

/**
 * Transactional email APIs as senders per sub-account (Einstellungen → E-Mail & SMS → Anbieter):
 * Resend, Postmark, Amazon SES, Brevo, Mailgun. The chosen provider plugs into deliverEmail via
 * app.services.emailTransports. One webhook address per provider takes delivery reports (delivered,
 * bounced, complaint → message status; hard bounce/complaint → „Nicht stören“) and, where the
 * provider offers it, inbound mail (alternative to IMAP).
 */

const chan = (p: MailProvider) => `mail:${p}`;
const SETTINGS = 'Einstellungen → E-Mail & SMS';

export function mailCreds(a: ChannelAccount) {
  return { secrets: a.secrets, config: a.config };
}

export function mailConfigured(p: MailProvider, a: ChannelAccount | undefined): a is ChannelAccount {
  if (!a?.enabled) return false;
  const spec = MAIL_PROVIDERS[p];
  return spec.secrets.every((f) => f.optional || !!a.secrets[f.key]) && spec.config.every((f) => f.optional || !!a.config[f.key] || !!f.options);
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export const emailProvidersModule: Module = {
  name: 'email-providers',
  register(app) {
    const { db, router } = app;
    const fetcher = () => channelFetch(app);
    const snsCerts = new Map<string, string>();
    const providerOf = (ctx: Ctx): MailProvider => {
      if (!isMailProvider(ctx.params.provider)) throw notFound('Unbekannter Anbieter');
      return ctx.params.provider;
    };
    const hookUrl = (p: MailProvider, a: ChannelAccount | undefined, loc: string) => (a ? `${app.baseUrl()}/hooks/mail/${p}/${loc}/${a.hook_key}` : '');

    const out = (p: MailProvider, loc: string, a: ChannelAccount | undefined) => {
      const spec = MAIL_PROVIDERS[p];
      return {
        provider: p,
        label: spec.label,
        configured: mailConfigured(p, a),
        config: Object.fromEntries(spec.config.map((f) => [f.key, a?.config[f.key] ?? (f.options ? f.options[0][0] : '')])),
        secrets_set: secretsSet(a, spec.secrets.map((f) => f.key)),
        fields: { secrets: spec.secrets.map(({ pattern: _p, ...f }) => f), config: spec.config.map(({ pattern: _p, ...f }) => f) },
        webhook_url: hookUrl(p, a, loc),
        signed: spec.signed,
        inbound: spec.inbound,
        last_webhook_at: a?.last_webhook_at ?? null,
        last_error: a?.last_error ?? null,
      };
    };
    const settingsOf = (loc: string) => app.location(loc)?.settings ?? {};
    const writeEmailSettings = (loc: string, patch: Record<string, any>) => {
      const s = settingsOf(loc);
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ ...s, email: { ...(s.email ?? {}), ...patch } }), loc);
    };

    // --- settings ----------------------------------------------------------------------------
    router.get('/api/settings/channels/mail', 'location', (ctx) => {
      const e = settingsOf(ctx.locationId).email ?? {};
      return {
        active: String(e.provider ?? 'log'),
        from: { fromName: e.fromName ?? '', fromEmail: e.fromEmail ?? '', replyTo: e.replyTo ?? '' },
        providers: Object.fromEntries((Object.keys(MAIL_PROVIDERS) as MailProvider[]).map((p) => [p, out(p, ctx.locationId, getAccount(app, ctx.locationId, chan(p)))])),
      };
    });

    router.put('/api/settings/channels/mail/:provider', 'location', (ctx) => {
      const p = providerOf(ctx);
      const spec = MAIL_PROVIDERS[p];
      const b = ctx.body ?? {};
      const secrets: Record<string, string | null> = {};
      for (const f of spec.secrets) {
        if (b[f.key] === null) secrets[f.key] = null;
        else if (b[f.key] !== undefined && b[f.key] !== '' && b[f.key] !== '••••••') {
          const v = str(b[f.key], f.label, { max: 300 }).replace(/\s+/g, '');
          if (f.pattern && !f.pattern.test(v)) throw bad(`${f.label} sieht ungültig aus${f.hint ? ` (${f.hint})` : ''}`);
          secrets[f.key] = v;
        }
      }
      const config: Record<string, any> = {};
      for (const f of spec.config) {
        if (b[f.key] === undefined) continue;
        const v = str(b[f.key], f.label, { max: 300 });
        if (f.options && !f.options.some(([k]) => k === v)) throw bad(`${f.label}: unbekannte Auswahl`);
        if (v && f.pattern && !f.pattern.test(v)) throw bad(`${f.label} sieht ungültig aus${f.hint ? ` (z. B. ${f.hint})` : ''}`);
        config[f.key] = v;
      }
      const from: Record<string, string> = {};
      for (const k of ['fromName', 'fromEmail', 'replyTo'] as const) {
        if (b[k] === undefined) continue;
        const v = str(b[k], k === 'fromName' ? 'Absendername' : k === 'fromEmail' ? 'Absender-E-Mail' : 'Antwort an', { max: 200 });
        if (v && k !== 'fromName' && !EMAIL.test(v)) throw bad(`${k === 'fromEmail' ? 'Absender-E-Mail' : 'Antwort an'}: keine gültige E-Mail-Adresse`);
        from[k] = v;
      }
      const a = saveAccount(app, ctx.locationId, chan(p), { config, secrets, regenerateKey: !!b.regenerate_webhook });
      if (b.activate) {
        if (!mailConfigured(p, a)) throw bad(`${spec.label}: bitte alle Pflichtfelder ausfüllen`);
        const fromEmail = from.fromEmail ?? settingsOf(ctx.locationId).email?.fromEmail;
        if (!fromEmail) throw bad('Absender-E-Mail fehlt – sie muss beim Anbieter bestätigt sein');
        writeEmailSettings(ctx.locationId, { ...from, provider: p });
      } else if (Object.keys(from).length) writeEmailSettings(ctx.locationId, from);
      return out(p, ctx.locationId, a);
    });

    router.delete('/api/settings/channels/mail/:provider', 'location', (ctx) => {
      const p = providerOf(ctx);
      deleteAccount(app, ctx.locationId, chan(p));
      if (settingsOf(ctx.locationId).email?.provider === p) writeEmailSettings(ctx.locationId, { provider: 'log' });
      return { ok: true };
    });

    router.post('/api/settings/channels/mail/:provider/test', 'location', async (ctx) => {
      const p = providerOf(ctx);
      const a = getAccount(app, ctx.locationId, chan(p));
      if (!mailConfigured(p, a)) throw bad(`${MAIL_PROVIDERS[p].label} ist noch nicht vollständig eingerichtet`);
      try {
        const info = await testMail(p, mailCreds(a), fetcher());
        noteError(app, ctx.locationId, chan(p), null);
        return { ok: true, info };
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    // --- sending: plugs into deliverEmail ---------------------------------------------------------
    const transport = (p: MailProvider) => async (loc: LocationRow, mail: OutMail) => {
      const a = getAccount(app, loc.id, chan(p));
      if (!mailConfigured(p, a)) throw new Error(`${MAIL_PROVIDERS[p].label} ist nicht eingerichtet (${SETTINGS})`);
      const cfg = loc.settings.email ?? {};
      const fromEmail = String(cfg.fromEmail ?? '').trim();
      if (!fromEmail) throw new Error(`Absender-E-Mail fehlt (${SETTINGS})`);
      const r = await sendMail(p, mailCreds(a), { fromEmail, fromName: mail.fromName || cfg.fromName, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: mail.replyTo || cfg.replyTo || undefined, ...(mail.headers ? { headers: mail.headers } : {}) }, fetcher());
      return { status: 'sent' as const, providerId: r.providerId || undefined };
    };
    app.services.emailTransports = { ...(app.services.emailTransports ?? {}), ...Object.fromEntries((Object.keys(MAIL_PROVIDERS) as MailProvider[]).map((p) => [p, transport(p)])) };

    // --- webhooks: delivery reports + inbound mail --------------------------------------------------
    // Each report is marked as seen together with what it changes (one transaction): when applying it fails, the mark goes too, so
    // the provider's retry is not taken for a duplicate.
    const apply = (loc: string, p: MailProvider, w: MailWebhook) => {
      let events = 0;
      let inbound = 0;
      for (const e of w.events) {
        events += db.tx(() => (e.eventId && !firstSeen(app, loc, chan(p), `ev:${e.eventId}`) ? 0 : applyDelivery(app, loc, 'email', e)));
      }
      for (const m of w.inbound) {
        inbound += db.tx(() => {
          if (m.messageId && !firstSeen(app, loc, chan(p), `in:${m.messageId}`)) return 0;
          receiveMessage(app, loc, { channel: 'email', from: m.from, name: m.name, subject: m.subject, body: m.text || '(ohne Text)', to: m.to });
          return 1;
        });
      }
      return { events, inbound };
    };

    router.post('/hooks/mail/:provider/:loc/:key', 'public', async (ctx) => {
      if (!isMailProvider(ctx.params.provider)) throw notFound();
      const p: MailProvider = ctx.params.provider;
      const a = getAccount(app, ctx.params.loc, chan(p));
      if (!a || !safeEqual(ctx.params.key, a.hook_key)) throw notFound();
      const loc = a.location_id;
      const type = header(ctx.req.headers, 'content-type');
      let body: any = ctx.body ?? {};
      if (/multipart\/form-data/i.test(type)) body = parseMultipart(ctx.rawBody, type);
      let w: MailWebhook = { events: [], inbound: [] };
      // Notification-level marks taken below (SNS message id, Mailgun token): undone when processing fails, so the provider's retry
      // gets another go instead of being answered "duplicate" for a notification that was never handled (as Stripe's webhook does).
      const marks: string[] = [];
      const mark = (eventId: string) => {
        if (!firstSeen(app, loc, chan(p), eventId)) return false;
        marks.push(eventId);
        return true;
      };
      try {
        switch (p) {
          case 'resend': {
            if (a.secrets.webhook_secret && !verifySvix(ctx.rawBody, header(ctx.req.headers, 'svix-id'), header(ctx.req.headers, 'svix-timestamp'), header(ctx.req.headers, 'svix-signature'), a.secrets.webhook_secret)) throw new HttpError(401, 'Signatur ungültig');
            w = parseResend(body);
            const id = header(ctx.req.headers, 'svix-id');
            if (id) w.events = w.events.map((e) => ({ ...e, eventId: id }));
            break;
          }
          case 'mailgun': {
            const sig = body['event-data'] ? body.signature : { timestamp: body.timestamp, token: body.token, signature: body.signature };
            if (a.secrets.webhook_signing_key) {
              if (!verifyMailgun(sig, a.secrets.webhook_signing_key)) throw new HttpError(401, 'Signatur ungültig');
              if (!mark(`tok:${String(sig?.token ?? '')}`)) return { ok: true, duplicate: true };
            }
            w = parseMailgun(body);
            break;
          }
          case 'ses': {
            if (typeof body.Message !== 'string' || !(await verifySns(body, fetcher(), snsCerts))) throw new HttpError(401, 'SNS-Signatur ungültig');
            if (a.config.topic_arn && body.TopicArn !== a.config.topic_arn) throw new HttpError(403, 'Unbekanntes SNS-Topic');
            if (body.Type === 'SubscriptionConfirmation') {
              if (!isSnsHost(String(body.SubscribeURL ?? ''))) throw bad('Unerwartete Bestätigungs-Adresse');
              try {
                const r = await fetcher()(String(body.SubscribeURL), { signal: AbortSignal.timeout(10_000) });
                if (!r.ok) throw new Error(`SNS ${r.status}`);
              } catch (e) {
                noteError(app, loc, chan(p), `SNS-Abo nicht bestätigt: ${(e as Error).message}`);
                throw new HttpError(502, 'SNS-Abo nicht bestätigt');
              }
              noteWebhook(app, loc, chan(p));
              return { ok: true, confirmed: true };
            }
            if (body.Type !== 'Notification') return { ok: true };
            if (!mark(`sns:${String(body.MessageId ?? '')}`)) return { ok: true, duplicate: true };
            w = await parseSesMessage(body.Message);
            break;
          }
          case 'postmark':
            w = parsePostmark(body);
            break;
          case 'brevo':
            w = parseBrevo(body);
            break;
        }
        noteWebhook(app, loc, chan(p));
        return { ok: true, ...apply(loc, p, w) };
      } catch (e) {
        for (const m of marks) forgetSeen(app, loc, chan(p), m);
        throw e;
      }
    });

    // --- workflows + catalogue --------------------------------------------------------------------
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), 'email.bounced', 'email.complained'];
    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: {
          key: 'mail_providers',
          name: 'E-Mail-Anbieter (Resend, Postmark, SES, Brevo, Mailgun)',
          category: 'Kommunikation',
          icon: 'email',
          scope: 'location',
          setup: { location: 'settings/messaging' },
          description: 'Transaktionaler Versand über eine E-Mail-API mit Zustell-Meldungen (zugestellt, Bounce, Spam → „Nicht stören“) und optional eingehenden Mails per Webhook.',
          credentials: 'API-Schlüssel des Anbieters und bestätigte Absender-Adresse unter Einstellungen → E-Mail & SMS; Webhook-Adresse beim Anbieter eintragen.',
          docs: 'docs/channels.md#email-providers',
        },
        location: (_ctx: Ctx, loc: string) => providerProbe(app, loc),
      },
    ];
  },
};

function providerProbe(app: App, loc: string) {
  const p = app.location(loc)?.settings.email?.provider;
  if (!isMailProvider(p)) return { status: 'info' as const, detail: p === 'smtp' ? 'SMTP aktiv' : 'Kein API-Anbieter gewählt' };
  const a = getAccount(app, loc, chan(p));
  if (!mailConfigured(p, a)) return { status: 'partial' as const, detail: `${MAIL_PROVIDERS[p].label} unvollständig` };
  if (a.last_error) return { status: 'partial' as const, detail: `${MAIL_PROVIDERS[p].label}: ${a.last_error.slice(0, 80)}` };
  return { status: 'ok' as const, detail: `${MAIL_PROVIDERS[p].label}${a.last_webhook_at ? ' · Meldungen kommen an' : ' · noch keine Zustell-Meldung'}` };
}
