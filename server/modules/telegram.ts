import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { now, token } from '../core/util.js';
import {
  channelFetch,
  deleteAccount,
  finishOutbound,
  firstSeen,
  getAccount,
  header,
  identityOfContact,
  noteError,
  noteWebhook,
  receiveChat,
  recordOutbound,
  safeEqual,
  saveAccount,
  serveMedia,
  setInfo,
  type ChannelAccount,
} from '../services/channel-kit.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { BOT_TOKEN, CAPTION_LIMIT, TEXT_LIMIT, TG_API, TelegramError, deepLink, parseUpdate, sendMethodFor, tgCall, type TgMessage } from '../services/telegram.js';

/**
 * Telegram as an inbox channel. Each sub-account connects its own bot (token from @BotFather,
 * sealed). Telegram posts updates to /hooks/telegram/<locationId> with the secret token header we
 * set; private chats become contacts and conversations. t.me/<bot>?start=<campaign> deep links
 * capture leads with the campaign as attribution source (event telegram.started).
 */

const CH = 'telegram';
const SETUP = 'Telegram ist nicht eingerichtet (Einstellungen → Weitere Kanäle)';

export interface TelegramSendInput {
  contactId: string;
  body?: string;
  mediaUrl?: string;
  userId?: string | null;
  source?: string;
  ignoreDnd?: boolean;
}

const TOOLS = [
  {
    name: 'ghl_telegram_link',
    title: 'Telegram-Link für Kampagne',
    description: 'Deep Link zum Telegram-Bot eines Projekts (t.me/<bot>?start=<kampagne>). Wer ihn öffnet und „Start“ drückt, wird Kontakt mit der Kampagne als Quelle. campaign: 1–64 Zeichen A–Z, a–z, 0–9, _ und -.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' }, campaign: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call: any, a: any) => call.api('GET', `/api/settings/channels/telegram/link${a.campaign ? `?campaign=${encodeURIComponent(a.campaign)}` : ''}`, { location: a.location_id }),
  },
];

export const telegramModule: Module = {
  name: 'telegram',
  register(app) {
    const { router } = app;
    const fetcher = () => channelFetch(app);
    const configured = (a: ChannelAccount | undefined): a is ChannelAccount => !!a?.enabled && !!a.secrets.bot_token;
    const call = <T = any>(a: ChannelAccount, method: string, body?: Record<string, unknown>, timeoutMs?: number) => tgCall<T>(fetcher(), a.secrets.bot_token, method, body, timeoutMs);

    const out = (a: ChannelAccount | undefined) => ({
      configured: configured(a),
      token_set: !!a?.secrets.bot_token,
      enabled: a ? a.enabled : true,
      bot: a?.info.username ? { id: a.info.id, username: a.info.username, name: a.info.name } : null,
      link: a?.info.username ? deepLink(a.info.username) : '',
      webhook_url: `${app.baseUrl()}/hooks/telegram/${a?.location_id ?? ''}`,
      webhook_set: !!a?.info.webhook_set_at,
      webhook_set_at: a?.info.webhook_set_at ?? null,
      welcome: a?.config.welcome ?? '',
      start_tags: a?.config.start_tags ?? [],
      last_webhook_at: a?.last_webhook_at ?? null,
      last_error: a?.last_error ?? null,
    });

    // --- settings (Einstellungen → Weitere Kanäle) ---------------------------------------
    router.get('/api/settings/channels/telegram', 'location', (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      return { ...out(a), webhook_url: `${app.baseUrl()}/hooks/telegram/${ctx.locationId}` };
    });

    router.put('/api/settings/channels/telegram', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cur = getAccount(app, ctx.locationId, CH);
      const config: Record<string, any> = {};
      if (b.welcome !== undefined) config.welcome = str(b.welcome, 'Begrüßung', { max: 2000 });
      if (b.start_tags !== undefined) config.start_tags = (Array.isArray(b.start_tags) ? b.start_tags : String(b.start_tags).split(',')).map((t: unknown) => String(t).trim().slice(0, 60)).filter(Boolean).slice(0, 10);
      const secrets: Record<string, string | null> = {};
      let info = cur?.info ?? {};
      if (b.bot_token === null) {
        secrets.bot_token = null;
        info = {};
      } else if (b.bot_token !== undefined && b.bot_token !== '' && b.bot_token !== '••••••') {
        const t = str(b.bot_token, 'Bot-Token', { max: 100 }).replace(/\s+/g, '');
        if (!BOT_TOKEN.test(t)) throw bad('Bot-Token sieht ungültig aus (Format 123456789:ABC… von @BotFather)');
        let me: any;
        try {
          me = await tgCall(fetcher(), t, 'getMe', undefined, 10_000);
        } catch (e) {
          throw bad(`Telegram lehnt den Token ab: ${(e as Error).message}`);
        }
        if (!me?.is_bot) throw bad('Der Token gehört zu keinem Bot');
        secrets.bot_token = t;
        // A new bot needs its webhook set again.
        info = { id: String(me.id), username: String(me.username ?? '').replace(/[^\w]/g, ''), name: String(me.first_name ?? '').slice(0, 120) };
      }
      if (!cur?.secrets.webhook_secret) secrets.webhook_secret = token(24);
      const a = saveAccount(app, ctx.locationId, CH, { config, secrets, info, enabled: b.enabled === undefined ? undefined : !!b.enabled });
      return out(a);
    });

    router.delete('/api/settings/channels/telegram', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (a?.secrets.bot_token) await call(a, 'deleteWebhook', {}, 8000).catch(() => undefined);
      deleteAccount(app, ctx.locationId, CH);
      return { ok: true };
    });

    /** Points the bot at this sub-account's webhook (with the secret token Telegram sends back on every update). */
    router.post('/api/settings/channels/telegram/webhook', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!configured(a)) throw bad(SETUP);
      const url = `${app.baseUrl()}/hooks/telegram/${ctx.locationId}`;
      if (!url.startsWith('https://')) throw bad('Telegram braucht eine öffentliche https-Adresse (PGHL_BASE_URL)');
      try {
        await call(a, 'setWebhook', { url, secret_token: a.secrets.webhook_secret, allowed_updates: ['message'], max_connections: 20 });
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
      setInfo(app, ctx.locationId, CH, { ...a.info, webhook_set_at: now() });
      noteError(app, ctx.locationId, CH, null);
      return out(getAccount(app, ctx.locationId, CH));
    });

    /** "Verbindung testen": bot name and Telegram's view of the webhook (pending updates, last error). */
    router.post('/api/settings/channels/telegram/test', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!configured(a)) throw bad(SETUP);
      try {
        const me = await call(a, 'getMe', undefined, 10_000);
        const wh = await call(a, 'getWebhookInfo', undefined, 10_000);
        const ours = wh?.url === `${app.baseUrl()}/hooks/telegram/${ctx.locationId}`;
        return {
          ok: true,
          info: `@${me.username}${ours ? ' · Webhook aktiv' : wh?.url ? ' · Webhook zeigt woandershin' : ' · Webhook noch nicht gesetzt'}${wh?.pending_update_count ? ` · ${wh.pending_update_count} wartende Updates` : ''}`,
          webhook: { url: wh?.url ?? '', ours, pending: Number(wh?.pending_update_count) || 0, last_error: wh?.last_error_message ?? null },
        };
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    router.get('/api/settings/channels/telegram/link', 'location', (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!a?.info.username) throw bad(SETUP);
      const campaign = str(ctx.query.get('campaign'), 'Kampagne', { max: 64 });
      if (campaign && !/^[A-Za-z0-9_-]{1,64}$/.test(campaign)) throw bad('Kampagne: 1–64 Zeichen, nur A–Z, a–z, 0–9, _ und -');
      return { link: deepLink(a.info.username, campaign), bot: a.info.username, campaign };
    });

    // --- sending ------------------------------------------------------------------------------
    const sendTelegram = async (loc: string, input: TelegramSendInput) => {
      const a = getAccount(app, loc, CH);
      if (!configured(a)) throw bad(SETUP);
      const c = getContact(app, loc, input.contactId);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const ident = identityOfContact(app, loc, c.id, CH);
      if (!ident?.chat_id) throw bad('Kontakt hat den Telegram-Bot noch nicht gestartet');
      const body = String(input.body ?? '').trim();
      const mediaUrl = String(input.mediaUrl ?? '').trim();
      if (!body && !mediaUrl) throw bad('Nachricht fehlt');
      if (mediaUrl && (!/^https:\/\/[^\s]+$/i.test(mediaUrl) || mediaUrl.length > 2000)) throw bad('Datei-Link muss mit https:// beginnen');
      const limit = mediaUrl ? CAPTION_LIMIT : TEXT_LIMIT;
      if (body.length > limit) throw bad(`Zu lang für Telegram: ${body.length} von max. ${limit} Zeichen${mediaUrl ? ' (Bildunterschrift)' : ''}`);
      const m = mediaUrl ? sendMethodFor(mediaUrl) : null;
      const rec = recordOutbound(app, loc, c, CH, body || (m ? `📎 ${mediaUrl.split(/[?#]/)[0].split('/').pop()}` : ''), { userId: input.userId, source: input.source, media: m ? { kind: m.kind, url: mediaUrl } : null });
      if (c.dnd && !input.ignoreDnd) return finishOutbound(app, rec, { ok: false, error: 'Kontakt hat „Nicht stören“ aktiv' });
      try {
        const r = m
          ? await call(a, m.method, { chat_id: ident.chat_id, [m.field]: mediaUrl, ...(body ? { caption: body } : {}) })
          : await call(a, 'sendMessage', { chat_id: ident.chat_id, text: body });
        return finishOutbound(app, rec, { ok: true, providerId: r?.message_id !== undefined ? String(r.message_id) : null });
      } catch (e) {
        if (e instanceof TelegramError && e.code === 403) logActivity(app, loc, c.id, 'telegram.blocked', 'Kontakt hat den Telegram-Bot blockiert');
        return finishOutbound(app, rec, { ok: false, error: (e as Error).message });
      }
    };
    app.services.telegramSend = sendTelegram;

    const fromRequest = (ctx: Ctx) =>
      sendTelegram(ctx.locationId, {
        contactId: str(ctx.body?.contact_id, 'Kontakt', { required: true }),
        body: ctx.body?.body === undefined ? undefined : str(ctx.body.body, 'Nachricht', { max: 10_000 }),
        mediaUrl: ctx.body?.media_url === undefined ? undefined : str(ctx.body.media_url, 'Datei-Link', { max: 2000 }),
        userId: ctx.user?.id,
        source: typeof ctx.body?.source === 'string' ? ctx.body.source.slice(0, 60) : undefined,
        ignoreDnd: !!ctx.body?.ignoreDnd,
      });
    app.services.messageChannels = { ...(app.services.messageChannels ?? {}), telegram: fromRequest };

    app.services.channelStatus = {
      ...(app.services.channelStatus ?? {}),
      telegram: (loc: string, c: { id: string }) => {
        const a = getAccount(app, loc, CH);
        if (!configured(a)) return { configured: false };
        const ident = identityOfContact(app, loc, c.id, CH);
        return { configured: true, reachable: !!ident?.chat_id, reason: ident?.chat_id ? undefined : 'Kontakt hat den Telegram-Bot noch nicht gestartet', limit: TEXT_LIMIT, media: true, handle: ident?.handle ? `@${ident.handle}` : ident?.name ?? '', bot: a.info.username ?? '' };
      },
    };

    app.services.channelMedia = {
      ...(app.services.channelMedia ?? {}),
      telegram: async (loc: string, media: any) => {
        if (!media.file_id || !/^[\w-]{10,300}$/.test(String(media.file_id))) throw notFound();
        const a = getAccount(app, loc, CH);
        if (!configured(a)) throw new HttpError(409, 'Telegram ist nicht mehr verbunden');
        let file: any;
        try {
          file = await call(a, 'getFile', { file_id: media.file_id }, 10_000);
        } catch (e) {
          throw new HttpError(502, (e as Error).message);
        }
        const path = String(file?.file_path ?? '');
        if (!/^[\w./-]{1,300}$/.test(path) || path.includes('..')) throw new HttpError(502, 'Datei bei Telegram nicht verfügbar (über 20 MB?)');
        return serveMedia(fetcher(), `${TG_API}/file/bot${a.secrets.bot_token}/${path}`, { allowHost: (h) => h === 'api.telegram.org', mime: media.mime, filename: media.filename || path.split('/').pop() });
      },
    };

    // --- inbound ------------------------------------------------------------------------------
    const handle = async (a: ChannelAccount, m: TgMessage) => {
      const loc = a.location_id;
      const base = { channel: CH, externalUser: m.fromId, name: m.name, handle: m.username, chatId: m.chatId, externalId: `tg:${m.chatId}:${m.messageId}`, at: m.at };
      if (m.start !== null) {
        const campaign = m.start;
        const r = receiveChat(app, loc, { ...base, body: campaign ? `▶️ Bot gestartet · Kampagne „${campaign}“` : '▶️ Bot gestartet', tags: a.config.start_tags ?? [], emit: false });
        if (!r) return;
        // The deep link's campaign becomes the lead's source (Attribution: telegram / bot / <campaign>).
        if (campaign || r.created) {
          app.services.attribution?.capture?.(undefined, loc, r.contact.id, 'telegram', { params: { utm_source: 'telegram', utm_medium: 'bot', ...(campaign ? { utm_campaign: campaign } : {}) } });
        }
        app.events.emit(loc, 'telegram.started', { contactId: r.contact.id, contact: getContact(app, loc, r.contact.id), campaign, created: r.created });
        const welcome = String(a.config.welcome ?? '').trim();
        if (welcome) {
          const text = render(welcome, { contact: contactVars(getContact(app, loc, r.contact.id)), location: { name: app.location(loc)?.name ?? '' } });
          await sendTelegram(loc, { contactId: r.contact.id, body: text, source: 'Begrüßung', ignoreDnd: true });
        }
        return;
      }
      const r = receiveChat(app, loc, { ...base, body: m.body, media: m.media, fields: m.phone ? { phone: m.phone } : undefined });
      if (r && m.phone && !r.contact.phone) app.db.run('UPDATE contacts SET phone = ?, updated_at = ? WHERE id = ?', m.phone, now(), r.contact.id);
    };

    router.post('/hooks/telegram/:loc', 'public', async (ctx) => {
      const a = getAccount(app, ctx.params.loc, CH);
      if (!a || !a.secrets.webhook_secret) throw notFound();
      if (!safeEqual(header(ctx.req.headers, 'x-telegram-bot-api-secret-token'), a.secrets.webhook_secret)) throw new HttpError(401, 'Secret-Token stimmt nicht');
      noteWebhook(app, a.location_id, CH);
      if (!a.enabled) return { ok: true, skipped: 'aus' };
      const m = parseUpdate(ctx.body);
      // Groups and channels stay out of the inbox; so do other bots.
      if (!m || m.chatType !== 'private' || m.isBot) return { ok: true, skipped: true };
      if (!firstSeen(app, a.location_id, CH, `u:${m.updateId}`)) return { ok: true, duplicate: true };
      try {
        await handle(a, m);
      } catch (e) {
        // Answer 200 anyway: Telegram would otherwise retry the same update for hours.
        console.error('[telegram] update failed', e);
        noteError(app, a.location_id, CH, `Eingang fehlgeschlagen: ${(e as Error).message}`);
      }
      return { ok: true };
    });

    // --- workflows, MCP, catalogue -------------------------------------------------------
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      telegram_send: async (run: any, step: any, vars: Record<string, any>) => {
        const r = await sendTelegram(run.location_id, { contactId: run.contact_id, body: render(String(step.body ?? ''), vars), mediaUrl: render(String(step.media_url ?? ''), vars).trim() || undefined, source: 'Workflow' });
        if (r.status === 'failed') throw new Error(r.error);
        return 'Telegram gesendet';
      },
    };
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), 'telegram.started'];
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'telegram.started': (c: Record<string, any>, d: Record<string, any>) => !c.campaign || String(c.campaign) === String(d.campaign ?? ''),
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: { key: 'telegram', name: 'Telegram', category: 'Kommunikation', icon: 'telegram', scope: 'location', setup: { location: 'settings/more-channels' }, description: 'Telegram-Bot im Posteingang: Nachrichten, Fotos, Sprachnachrichten, Dokumente; Deep Links t.me/<bot>?start=<kampagne> als Lead-Quelle.', credentials: 'Bot-Token von @BotFather unter Einstellungen → Weitere Kanäle, dann „Webhook setzen“.', docs: 'docs/channels.md#telegram' },
        location: (_ctx: Ctx, loc: string) => {
          const a = getAccount(app, loc, CH);
          if (!configured(a)) return { status: 'missing', detail: 'Kein Bot-Token' };
          if (a.last_error) return { status: 'partial', detail: `Fehler: ${a.last_error.slice(0, 80)}` };
          return a.info.webhook_set_at ? { status: 'ok', detail: `@${a.info.username}` } : { status: 'partial', detail: `@${a.info.username} · Webhook noch nicht gesetzt` };
        },
      },
    ];
  },
};
