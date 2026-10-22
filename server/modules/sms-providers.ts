import type { App, LocationRow, Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { applyDelivery, channelFetch, deleteAccount, firstSeen, getAccount, header, noteError, noteWebhook, publicUrl, safeEqual, saveAccount, secretsSet, type ChannelAccount } from '../services/channel-kit.js';
import { receiveMessage } from '../services/messaging.js';
import { SMS_PROVIDERS, isSmsProvider, parseBird, parsePlivo, parseSeven, parseVonage, sendSms, testSms, verifyBird, verifyPlivo, verifySeven, verifyVonageJwt, type SmsProvider, type SmsWebhook } from '../services/sms-providers.js';

/**
 * SMS APIs besides Twilio, chosen per sub-account (Einstellungen → E-Mail & SMS → Anbieter):
 * seven.io, Bird, Vonage, Plivo. The provider plugs into deliverSms via app.services.smsTransports;
 * one webhook address per provider takes delivery reports (zugestellt/fehlgeschlagen) and inbound
 * SMS (→ Konversationen, STOP → „Nicht stören“). Signatures are checked where the provider signs.
 */

const chan = (p: SmsProvider) => `sms:${p}`;

export function smsConfigured(p: SmsProvider, a: ChannelAccount | undefined): a is ChannelAccount {
  if (!a?.enabled) return false;
  const spec = SMS_PROVIDERS[p];
  return spec.secrets.every((f) => f.optional || !!a.secrets[f.key]) && spec.config.every((f) => f.optional || !!a.config[f.key]);
}

export const smsProvidersModule: Module = {
  name: 'sms-providers',
  register(app) {
    const { db, router } = app;
    const fetcher = () => channelFetch(app);
    const providerOf = (ctx: Ctx): SmsProvider => {
      if (!isSmsProvider(ctx.params.provider)) throw notFound('Unbekannter Anbieter');
      return ctx.params.provider;
    };
    const path = (p: SmsProvider, loc: string, a: ChannelAccount) => `/hooks/sms/${p}/${loc}/${a.hook_key}`;

    const out = (p: SmsProvider, loc: string, a: ChannelAccount | undefined) => {
      const spec = SMS_PROVIDERS[p];
      return {
        provider: p,
        label: spec.label,
        configured: smsConfigured(p, a),
        config: Object.fromEntries(spec.config.map((f) => [f.key, a?.config[f.key] ?? ''])),
        secrets_set: secretsSet(a, spec.secrets.map((f) => f.key)),
        fields: { secrets: spec.secrets.map(({ pattern: _p, ...f }) => f), config: spec.config.map(({ pattern: _p, ...f }) => f) },
        webhook_url: a ? `${app.baseUrl()}${path(p, loc, a)}` : '',
        signed: spec.signed,
        last_webhook_at: a?.last_webhook_at ?? null,
        last_error: a?.last_error ?? null,
      };
    };
    const settingsOf = (loc: string) => app.location(loc)?.settings ?? {};
    const writeSmsSettings = (loc: string, patch: Record<string, any>) => {
      const s = settingsOf(loc);
      db.run('UPDATE locations SET settings = ? WHERE id = ?', JSON.stringify({ ...s, sms: { ...(s.sms ?? {}), ...patch } }), loc);
    };

    // --- settings ----------------------------------------------------------------------------
    router.get('/api/settings/channels/sms', 'location', (ctx) => ({
      active: String(settingsOf(ctx.locationId).sms?.provider ?? 'log'),
      providers: Object.fromEntries((Object.keys(SMS_PROVIDERS) as SmsProvider[]).map((p) => [p, out(p, ctx.locationId, getAccount(app, ctx.locationId, chan(p)))])),
    }));

    router.put('/api/settings/channels/sms/:provider', 'location', (ctx) => {
      const p = providerOf(ctx);
      const spec = SMS_PROVIDERS[p];
      const b = ctx.body ?? {};
      const secrets: Record<string, string | null> = {};
      for (const f of spec.secrets) {
        if (b[f.key] === null) secrets[f.key] = null;
        else if (b[f.key] !== undefined && b[f.key] !== '' && b[f.key] !== '••••••') {
          const v = str(b[f.key], f.label, { max: 300 }).replace(/\s+/g, '');
          if (f.pattern && !f.pattern.test(v)) throw bad(`${f.label} sieht ungültig aus`);
          secrets[f.key] = v;
        }
      }
      const config: Record<string, any> = {};
      for (const f of spec.config) {
        if (b[f.key] === undefined) continue;
        const v = str(b[f.key], f.label, { max: 100 });
        if (v && f.pattern && !f.pattern.test(v)) throw bad(`${f.label} sieht ungültig aus${f.hint ? ` (z. B. ${f.hint})` : ''}`);
        config[f.key] = v;
      }
      const a = saveAccount(app, ctx.locationId, chan(p), { config, secrets, regenerateKey: !!b.regenerate_webhook });
      if (b.activate) {
        if (!smsConfigured(p, a)) throw bad(`${spec.label}: bitte alle Pflichtfelder ausfüllen`);
        writeSmsSettings(ctx.locationId, { provider: p });
      }
      return out(p, ctx.locationId, a);
    });

    router.delete('/api/settings/channels/sms/:provider', 'location', (ctx) => {
      const p = providerOf(ctx);
      deleteAccount(app, ctx.locationId, chan(p));
      if (settingsOf(ctx.locationId).sms?.provider === p) writeSmsSettings(ctx.locationId, { provider: 'log' });
      return { ok: true };
    });

    router.post('/api/settings/channels/sms/:provider/test', 'location', async (ctx) => {
      const p = providerOf(ctx);
      const a = getAccount(app, ctx.locationId, chan(p));
      if (!smsConfigured(p, a)) throw bad(`${SMS_PROVIDERS[p].label} ist noch nicht vollständig eingerichtet`);
      try {
        const info = await testSms(p, { secrets: a.secrets, config: a.config }, fetcher());
        noteError(app, ctx.locationId, chan(p), null);
        return { ok: true, info };
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    // --- sending: plugs into deliverSms -----------------------------------------------------------
    const transport = (p: SmsProvider) => async (loc: LocationRow, to: string, body: string) => {
      const a = getAccount(app, loc.id, chan(p));
      if (!smsConfigured(p, a)) throw new Error(`${SMS_PROVIDERS[p].label} ist nicht eingerichtet (Einstellungen → E-Mail & SMS)`);
      const r = await sendSms(p, { secrets: a.secrets, config: a.config }, to, body, fetcher(), `${app.baseUrl()}${path(p, loc.id, a)}`);
      return { status: 'sent' as const, providerId: r.providerId || undefined };
    };
    app.services.smsTransports = { ...(app.services.smsTransports ?? {}), ...Object.fromEntries((Object.keys(SMS_PROVIDERS) as SmsProvider[]).map((p) => [p, transport(p)])) };

    // --- webhooks: delivery reports + inbound SMS ---------------------------------------------------
    router.post('/hooks/sms/:provider/:loc/:key', 'public', (ctx) => {
      if (!isSmsProvider(ctx.params.provider)) throw notFound();
      const p: SmsProvider = ctx.params.provider;
      const a = getAccount(app, ctx.params.loc, chan(p));
      if (!a || !safeEqual(ctx.params.key, a.hook_key)) throw notFound();
      const loc = a.location_id;
      const url = publicUrl(app, ctx.url.pathname, ctx.url.search);
      const h = (n: string) => header(ctx.req.headers, n);
      let w: SmsWebhook = { events: [], inbound: [] };
      switch (p) {
        case 'seven':
          if (a.secrets.signing_secret && !verifySeven({ timestamp: h('x-timestamp'), nonce: h('x-nonce'), method: ctx.method, url, body: ctx.rawBody, signature: h('x-signature') }, a.secrets.signing_secret)) throw new HttpError(401, 'Signatur ungültig');
          w = parseSeven(ctx.body);
          break;
        case 'bird':
          if (a.secrets.signing_key && !verifyBird(h('messagebird-request-timestamp'), url, ctx.rawBody, h('messagebird-signature'), a.secrets.signing_key)) throw new HttpError(401, 'Signatur ungültig');
          w = parseBird(ctx.body);
          break;
        case 'vonage':
          if (a.secrets.signature_secret && !verifyVonageJwt(h('authorization'), a.secrets.signature_secret, ctx.rawBody)) throw new HttpError(401, 'Signatur ungültig');
          w = parseVonage(ctx.body);
          break;
        case 'plivo':
          if (!verifyPlivo(url, h('x-plivo-signature-v2-nonce'), h('x-plivo-signature-v2'), a.secrets.auth_token)) throw new HttpError(401, 'Signatur ungültig');
          w = parsePlivo(ctx.body);
          break;
      }
      noteWebhook(app, loc, chan(p));
      let events = 0;
      let inbound = 0;
      for (const e of w.events) {
        if (e.eventId && !firstSeen(app, loc, chan(p), `ev:${e.eventId}`)) continue;
        events += applyDelivery(app, loc, 'sms', e);
      }
      for (const m of w.inbound) {
        if (m.id && !firstSeen(app, loc, chan(p), `in:${m.id}`)) continue;
        receiveMessage(app, loc, { channel: 'sms', from: m.from, body: m.text || '(leer)', to: m.to });
        inbound++;
      }
      // Plivo's message URL may expect XML; an empty <Response/> sends no auto-reply.
      if (p === 'plivo') return text('<Response></Response>', 'text/xml');
      return { ok: true, events, inbound };
    });

    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: {
          key: 'sms_providers',
          name: 'SMS-Anbieter (seven.io, Bird, Vonage, Plivo)',
          category: 'Kommunikation',
          icon: 'sms',
          scope: 'location',
          setup: { location: 'settings/messaging' },
          description: 'SMS über europäische und weltweite Anbieter statt Twilio – mit Zustellberichten und eingehenden SMS.',
          credentials: 'API-Zugang des Anbieters und Absender unter Einstellungen → E-Mail & SMS; Webhook-Adresse beim Anbieter eintragen.',
          docs: 'docs/channels.md#sms-providers',
        },
        location: (_ctx: Ctx, loc: string) => probe(app, loc),
      },
    ];
  },
};

function probe(app: App, loc: string) {
  const p = app.location(loc)?.settings.sms?.provider;
  if (!isSmsProvider(p)) return { status: 'info' as const, detail: p === 'twilio' ? 'Twilio aktiv' : p === 'http' ? 'HTTP-Gateway aktiv' : 'Kein API-Anbieter gewählt' };
  const a = getAccount(app, loc, chan(p));
  if (!smsConfigured(p, a)) return { status: 'partial' as const, detail: `${SMS_PROVIDERS[p].label} unvollständig` };
  if (a.last_error) return { status: 'partial' as const, detail: `${SMS_PROVIDERS[p].label}: ${a.last_error.slice(0, 80)}` };
  return { status: 'ok' as const, detail: SMS_PROVIDERS[p].label };
}
