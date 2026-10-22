import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import {
  accountsOf,
  channelFetch,
  deleteAccount,
  finishOutbound,
  getAccount,
  header,
  identityOfContact,
  linkIdentity,
  noteError,
  noteWebhook,
  receiveChat,
  recordOutbound,
  saveAccount,
  serveMedia,
  type ChannelAccount,
} from '../services/channel-kit.js';
import { getContact } from '../services/contacts.js';
import {
  DiscordGateway,
  SNOWFLAKE,
  SUPPORT_COMMAND,
  TEXT_LIMIT,
  discordCall,
  inviteUrl,
  isDiscordCdn,
  parseMessage,
  verifyInteraction,
  type WsFactory,
  type WsLike,
} from '../services/discord.js';

/**
 * Discord as an inbox channel for a community server: the bot listens (Gateway) to direct messages
 * and to the channels chosen in the settings; each author becomes a contact. Replies go back as a
 * direct message – or, if wanted, as a reply in the channel the person wrote in. Members can also
 * use the slash command /support (Interactions endpoint, Ed25519-signed). Tests pass a fake socket
 * via app.services.discordSocket and fake REST via app.services.channelFetch.
 */

const CH = 'discord';
const SETUP = 'Discord ist nicht eingerichtet (Einstellungen → Weitere Kanäle)';

export interface DiscordSendInput {
  contactId: string;
  body?: string;
  userId?: string | null;
  source?: string;
  ignoreDnd?: boolean;
}

export const discordModule: Module = {
  name: 'discord',
  register(app) {
    const { router } = app;
    const fetcher = () => channelFetch(app);
    const configured = (a: ChannelAccount | undefined): a is ChannelAccount => !!a?.enabled && !!a.secrets.bot_token;
    const rest = <T = any>(a: ChannelAccount, method: string, path: string, body?: unknown) => discordCall<T>(fetcher(), a.secrets.bot_token, method, path, body);
    const socket = (): WsFactory => app.services.discordSocket ?? ((url: string) => new WebSocket(url) as unknown as WsLike);

    // --- gateway connections (one per sub-account with a bot) --------------------------------
    const gateways = new Map<string, DiscordGateway>();
    const onMessage = (loc: string, d: any) => {
      const a = getAccount(app, loc, CH);
      if (!configured(a)) return;
      const m = parseMessage(d);
      if (!m) return;
      const watched: string[] = a.config.channel_ids ?? [];
      if (m.guildId && !watched.includes(m.channelId)) return;
      if (m.authorId === a.info.bot_id) return;
      const dm = !m.guildId;
      try {
        receiveChat(app, loc, {
          channel: CH,
          externalUser: m.authorId,
          name: m.name,
          handle: m.username,
          chatId: m.channelId,
          body: m.body,
          media: m.media,
          externalId: `dc:${m.id}`,
          at: m.at,
          identityData: dm ? { dm_channel_id: m.channelId, last_from: 'dm' } : { last_from: 'channel', last_channel_id: m.channelId, last_message_id: m.id, guild_id: m.guildId },
        });
      } catch (e) {
        console.error('[discord] message failed', e);
        noteError(app, loc, CH, `Eingang fehlgeschlagen: ${(e as Error).message}`);
      }
    };
    const ensure = (loc: string) => {
      const a = getAccount(app, loc, CH);
      const want = configured(a) && a.config.gateway !== false;
      const g = gateways.get(loc);
      if (g && (!want || g.token !== a?.secrets.bot_token)) {
        g.stop();
        gateways.delete(loc);
      } else if (g) return;
      if (!want) return;
      const gw = new DiscordGateway({
        token: a!.secrets.bot_token,
        socket: socket(),
        onDispatch: (t, d) => {
          if (t === 'MESSAGE_CREATE') onMessage(loc, d);
        },
        onState: (status, error) => {
          if (status === 'error') noteError(app, loc, CH, error ?? 'Gateway-Fehler');
          if (status === 'ready') noteError(app, loc, CH, null);
        },
      });
      gateways.set(loc, gw);
      gw.start();
    };
    app.onTick(() => {
      const live = new Set<string>();
      for (const a of accountsOf(app, CH)) {
        live.add(a.location_id);
        // A fatal error (bad token, missing intent) waits for new settings instead of hammering Discord.
        if (gateways.get(a.location_id)?.status !== 'error') ensure(a.location_id);
      }
      for (const [loc, g] of gateways) if (!live.has(loc)) (g.stop(), gateways.delete(loc));
    });
    app.services.discordGateways = gateways;

    const out = (loc: string, a: ChannelAccount | undefined) => {
      const g = gateways.get(loc);
      return {
        configured: configured(a),
        token_set: !!a?.secrets.bot_token,
        enabled: a ? a.enabled : true,
        bot: a?.info.bot_id ? { id: a.info.bot_id, name: a.info.bot_name, app_id: a.info.app_id } : null,
        invite_url: a?.info.app_id ? inviteUrl(a.info.app_id) : '',
        interactions_url: `${app.baseUrl()}/hooks/discord/${loc}`,
        public_key_set: !!a?.config.public_key,
        channel_ids: a?.config.channel_ids ?? [],
        reply_in_channel: !!a?.config.reply_in_channel,
        command_reply: a?.config.command_reply ?? '',
        gateway: { status: g?.status ?? (configured(a) ? 'idle' : 'off'), error: g?.error || null },
        last_webhook_at: a?.last_webhook_at ?? null,
        last_error: a?.last_error ?? null,
      };
    };

    // --- settings ----------------------------------------------------------------------------
    router.get('/api/settings/channels/discord', 'location', (ctx) => out(ctx.locationId, getAccount(app, ctx.locationId, CH)));

    router.put('/api/settings/channels/discord', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cur = getAccount(app, ctx.locationId, CH);
      const config: Record<string, any> = {};
      if (b.channel_ids !== undefined) {
        const ids = (Array.isArray(b.channel_ids) ? b.channel_ids : String(b.channel_ids).split(/[\s,]+/)).map((x: unknown) => String(x).trim()).filter(Boolean);
        for (const x of ids) if (!SNOWFLAKE.test(x)) throw bad(`Kanal-ID „${x.slice(0, 30)}“ ist ungültig (Rechtsklick auf den Kanal → ID kopieren)`);
        config.channel_ids = [...new Set(ids)].slice(0, 20);
      }
      if (b.reply_in_channel !== undefined) config.reply_in_channel = !!b.reply_in_channel;
      if (b.command_reply !== undefined) config.command_reply = str(b.command_reply, 'Antwort auf /support', { max: 500 });
      if (b.gateway !== undefined) config.gateway = !!b.gateway;
      const secrets: Record<string, string | null> = {};
      let info = cur?.info ?? {};
      if (b.bot_token === null) {
        secrets.bot_token = null;
        info = {};
      } else if (b.bot_token !== undefined && b.bot_token !== '' && b.bot_token !== '••••••') {
        const t = str(b.bot_token, 'Bot-Token', { max: 200 }).replace(/\s+/g, '');
        if (!/^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(t)) throw bad('Bot-Token sieht ungültig aus (Developer Portal → Bot → Reset Token)');
        try {
          const me = await discordCall(fetcher(), t, 'GET', '/users/@me', undefined, 10_000);
          const appInfo = await discordCall(fetcher(), t, 'GET', '/applications/@me', undefined, 10_000);
          info = { bot_id: String(me?.id ?? ''), bot_name: String(me?.username ?? '').slice(0, 80), app_id: String(appInfo?.id ?? ''), app_name: String(appInfo?.name ?? '').slice(0, 80) };
          if (appInfo?.verify_key && /^[0-9a-f]{64}$/i.test(appInfo.verify_key)) config.public_key = String(appInfo.verify_key).toLowerCase();
        } catch (e) {
          throw bad(`Discord lehnt den Token ab: ${(e as Error).message}`);
        }
        secrets.bot_token = t;
      }
      if (b.public_key !== undefined && b.public_key !== '') {
        const k = str(b.public_key, 'Public Key', { max: 64 }).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(k)) throw bad('Public Key: 64 Hex-Zeichen (Developer Portal → General Information)');
        config.public_key = k;
      }
      const a = saveAccount(app, ctx.locationId, CH, { config, secrets, info, enabled: b.enabled === undefined ? undefined : !!b.enabled });
      const g = gateways.get(ctx.locationId);
      if (g && (g.status === 'error' || g.token !== a.secrets.bot_token)) (g.stop(), gateways.delete(ctx.locationId));
      ensure(ctx.locationId);
      return out(ctx.locationId, a);
    });

    router.delete('/api/settings/channels/discord', 'location', (ctx) => {
      gateways.get(ctx.locationId)?.stop();
      gateways.delete(ctx.locationId);
      deleteAccount(app, ctx.locationId, CH);
      return { ok: true };
    });

    /** Registers the /support slash command for the bot's application (global, also in DMs). */
    router.post('/api/settings/channels/discord/commands', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!configured(a) || !a.info.app_id) throw bad(SETUP);
      try {
        const list = await rest<any[]>(a, 'PUT', `/applications/${a.info.app_id}/commands`, [SUPPORT_COMMAND]);
        return { ok: true, commands: (list ?? []).map((c) => c.name) };
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    router.post('/api/settings/channels/discord/test', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!configured(a)) throw bad(SETUP);
      try {
        const me = await rest(a, 'GET', '/users/@me');
        const guilds = await rest<any[]>(a, 'GET', '/users/@me/guilds');
        const g = gateways.get(ctx.locationId);
        return { ok: true, info: `${me?.username ?? 'Bot'} · ${guilds?.length ?? 0} Server${g?.status === 'ready' ? ' · verbunden' : g?.error ? ` · ${g.error}` : ' · verbindet …'}` };
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
    });

    // --- sending ------------------------------------------------------------------------------
    const sendDiscord = async (loc: string, input: DiscordSendInput) => {
      const a = getAccount(app, loc, CH);
      if (!configured(a)) throw bad(SETUP);
      const c = getContact(app, loc, input.contactId);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const ident = identityOfContact(app, loc, c.id, CH);
      if (!ident) throw bad('Kontakt hat noch nicht über Discord geschrieben');
      const body = String(input.body ?? '').trim();
      if (!body) throw bad('Nachricht fehlt');
      if (body.length > TEXT_LIMIT) throw bad(`Zu lang für Discord: ${body.length} von max. ${TEXT_LIMIT} Zeichen`);
      const rec = recordOutbound(app, loc, c, CH, body, { userId: input.userId, source: input.source });
      if (c.dnd && !input.ignoreDnd) return finishOutbound(app, rec, { ok: false, error: 'Kontakt hat „Nicht stören“ aktiv' });
      try {
        const d = ident.data ?? {};
        let channelId = '';
        let payload: Record<string, any> = { content: body, allowed_mentions: { parse: [] } };
        if (a.config.reply_in_channel && d.last_from === 'channel' && SNOWFLAKE.test(String(d.last_channel_id ?? ''))) {
          channelId = d.last_channel_id;
          payload = { ...payload, message_reference: { message_id: d.last_message_id, fail_if_not_exists: false }, allowed_mentions: { parse: [], replied_user: true } };
        } else {
          channelId = SNOWFLAKE.test(String(d.dm_channel_id ?? '')) ? d.dm_channel_id : '';
          if (!channelId) {
            const dm = await rest(a, 'POST', '/users/@me/channels', { recipient_id: ident.external_id });
            channelId = String(dm?.id ?? '');
            if (!SNOWFLAKE.test(channelId)) throw new Error('Discord hat keinen Direktnachrichten-Kanal geöffnet');
            linkIdentity(app, loc, CH, ident.external_id, c.id, { data: { dm_channel_id: channelId } });
          }
        }
        const r = await rest(a, 'POST', `/channels/${channelId}/messages`, payload);
        return finishOutbound(app, rec, { ok: true, providerId: r?.id ? String(r.id) : null });
      } catch (e) {
        return finishOutbound(app, rec, { ok: false, error: (e as Error).message });
      }
    };
    app.services.discordSend = sendDiscord;

    app.services.messageChannels = {
      ...(app.services.messageChannels ?? {}),
      discord: (ctx: Ctx) =>
        sendDiscord(ctx.locationId, {
          contactId: str(ctx.body?.contact_id, 'Kontakt', { required: true }),
          body: str(ctx.body?.body, 'Nachricht', { max: 10_000 }),
          userId: ctx.user?.id,
          source: typeof ctx.body?.source === 'string' ? ctx.body.source.slice(0, 60) : undefined,
          ignoreDnd: !!ctx.body?.ignoreDnd,
        }),
    };

    app.services.channelStatus = {
      ...(app.services.channelStatus ?? {}),
      discord: (loc: string, c: { id: string }) => {
        const a = getAccount(app, loc, CH);
        if (!configured(a)) return { configured: false };
        const ident = identityOfContact(app, loc, c.id, CH);
        return {
          configured: true,
          reachable: !!ident,
          reason: ident ? undefined : 'Kontakt hat noch nicht über Discord geschrieben',
          limit: TEXT_LIMIT,
          handle: ident?.handle ? `@${ident.handle}` : ident?.name ?? '',
          where: a.config.reply_in_channel && ident?.data?.last_from === 'channel' ? 'channel' : 'dm',
        };
      },
    };

    app.services.channelMedia = {
      ...(app.services.channelMedia ?? {}),
      discord: (_loc: string, media: any) => {
        if (!media.url || !isDiscordCdn(String(media.url))) throw notFound();
        return serveMedia(fetcher(), String(media.url), { allowHost: (h) => h === 'cdn.discordapp.com' || h === 'media.discordapp.net', mime: media.mime, filename: media.filename });
      },
    };

    // --- interactions endpoint (/support) ------------------------------------------------------
    router.post('/hooks/discord/:loc', 'public', (ctx) => {
      const a = getAccount(app, ctx.params.loc, CH);
      if (!a?.config.public_key) throw notFound();
      if (!verifyInteraction(ctx.rawBody, header(ctx.req.headers, 'x-signature-ed25519'), header(ctx.req.headers, 'x-signature-timestamp'), a.config.public_key)) throw new HttpError(401, 'invalid request signature');
      noteWebhook(app, a.location_id, CH);
      const i = ctx.body ?? {};
      if (i.type === 1) return { type: 1 }; // PING when the URL is saved in the Developer Portal
      const user = i.member?.user ?? i.user;
      const text = Array.isArray(i.data?.options) ? String(i.data.options.find((o: any) => o?.name === 'nachricht')?.value ?? '') : '';
      if (i.type !== 2 || i.data?.name !== 'support' || !user || !SNOWFLAKE.test(String(user.id ?? '')) || !text.trim()) {
        return { type: 4, data: { content: 'Diesen Befehl kenne ich nicht.', flags: 64 } };
      }
      if (!a.enabled) return { type: 4, data: { content: 'Gerade nicht erreichbar.', flags: 64 } };
      const dm = !i.guild_id;
      try {
        receiveChat(app, a.location_id, {
          channel: CH,
          externalUser: String(user.id),
          name: String(i.member?.nick || user.global_name || user.username || '').slice(0, 120),
          handle: String(user.username ?? '').replace(/[^\w.]/g, '').slice(0, 64),
          chatId: String(i.channel_id ?? ''),
          body: text.slice(0, TEXT_LIMIT),
          externalId: `dci:${String(i.id ?? '').slice(0, 30)}`,
          identityData: dm ? { dm_channel_id: String(i.channel_id ?? ''), last_from: 'dm' } : { last_from: 'command' },
        });
      } catch (e) {
        noteError(app, a.location_id, CH, `Eingang fehlgeschlagen: ${(e as Error).message}`);
      }
      const reply = String(a.config.command_reply || 'Danke! Wir antworten dir per Direktnachricht.');
      return { type: 4, data: { content: render(reply, {}).slice(0, TEXT_LIMIT), flags: 64 } };
    });

    // --- workflows, catalogue -----------------------------------------------------------------
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      discord_send: async (run: any, step: any, vars: Record<string, any>) => {
        const r = await sendDiscord(run.location_id, { contactId: run.contact_id, body: render(String(step.body ?? ''), vars), source: 'Workflow' });
        if (r.status === 'failed') throw new Error(r.error);
        return 'Discord gesendet';
      },
    };
    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: { key: 'discord', name: 'Discord', category: 'Kommunikation', icon: 'discord', scope: 'location', setup: { location: 'settings/more-channels' }, description: 'Bot für deinen Community-Server: Direktnachrichten, gewählte Kanäle und /support landen im Posteingang, Antworten gehen zurück.', credentials: 'Bot-Token aus dem Discord Developer Portal (Message Content Intent an) unter Einstellungen → Weitere Kanäle.', docs: 'docs/channels.md#discord' },
        location: (_ctx: Ctx, loc: string) => {
          const a = getAccount(app, loc, CH);
          if (!configured(a)) return { status: 'missing', detail: 'Kein Bot-Token' };
          const g = gateways.get(loc);
          if (g?.status === 'error' || a.last_error) return { status: 'partial', detail: `Fehler: ${(g?.error || a.last_error || '').slice(0, 80)}` };
          return { status: 'ok', detail: `${a.info.bot_name || 'Bot'}${g?.status === 'ready' ? ' · verbunden' : ''}` };
        },
      },
    ];
  },
};
