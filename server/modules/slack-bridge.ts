import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, type Ctx } from '../core/http.js';
import { now } from '../core/util.js';
import { channelSend } from './channels.js';
import { channelFetch, deleteAccount, firstSeen, getAccount, header, noteError, noteWebhook, saveAccount, type ChannelAccount } from '../services/channel-kit.js';
import { contactName, getContact } from '../services/contacts.js';
import { BOT_TOKEN, CHANNEL_ID, SIGNING_SECRET, fromSlack, isSlackWebhook, slackCall, slackEscape, slackQuote, verifySlack } from '../services/slack.js';

/**
 * Slack for the team: every new customer message (any channel) is posted to a Slack channel – one
 * thread per conversation. With a bot token and the Events API, a reply in that thread goes to the
 * customer through the channel they last wrote on (✅ reaction when sent, ⚠️ reply when not).
 * Messages starting with // stay internal. An incoming webhook works too (notifications only).
 */

const CH = 'slack';
const LABELS: Record<string, string> = { email: 'E-Mail', sms: 'SMS', chat: 'Website-Chat', whatsapp: 'WhatsApp', messenger: 'Messenger', instagram: 'Instagram', telegram: 'Telegram', discord: 'Discord' };
const label = (ch: string) => LABELS[ch] ?? ch;

export const slackBridgeModule: Module = {
  name: 'slack-bridge',
  migrations: [
    [
      '001-init',
      `CREATE TABLE slack_threads (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        slack_channel TEXT NOT NULL, thread_ts TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, conversation_id)
      );
      CREATE INDEX slack_threads_ts ON slack_threads(location_id, slack_channel, thread_ts);`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = () => channelFetch(app);
    const mode = (a: ChannelAccount | undefined) => (a?.config.mode === 'webhook' ? 'webhook' : 'bot');
    const ready = (a: ChannelAccount | undefined): a is ChannelAccount =>
      !!a?.enabled && (mode(a) === 'webhook' ? isSlackWebhook(a.secrets.webhook_url ?? '') : !!a.secrets.bot_token && CHANNEL_ID.test(a.config.channel ?? ''));
    const api = <T = any>(a: ChannelAccount, method: string, body: Record<string, unknown>) => slackCall<T>(fetcher(), a.secrets.bot_token, method, body);
    const postWebhook = async (a: ChannelAccount, text: string) => {
      const r = await fetcher()(a.secrets.webhook_url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Slack-Webhook ${r.status}: ${(await r.text().catch(() => '')).slice(0, 100)}`);
    };

    const out = (loc: string, a: ChannelAccount | undefined) => ({
      configured: ready(a),
      enabled: a ? a.enabled : true,
      mode: mode(a),
      channel: a?.config.channel ?? '',
      channels: a?.config.channels ?? [],
      bot_token_set: !!a?.secrets.bot_token,
      signing_secret_set: !!a?.secrets.signing_secret,
      webhook_url_set: !!a?.secrets.webhook_url,
      replies: mode(a) === 'bot' && !!a?.secrets.signing_secret,
      team: a?.info.team ?? '',
      events_url: `${app.baseUrl()}/hooks/slack/${loc}`,
      last_webhook_at: a?.last_webhook_at ?? null,
      last_error: a?.last_error ?? null,
    });

    // --- customer message → Slack ---------------------------------------------------------------
    const forward = async (loc: string, data: Record<string, any>) => {
      const a = getAccount(app, loc, CH);
      const m = data.message;
      if (!ready(a) || !m?.conversation_id || m.direction !== 'in' || m.channel === 'call') return;
      const filter: string[] = a.config.channels ?? [];
      if (filter.length && !filter.includes(m.channel)) return;
      const c = data.contact ?? getContact(app, loc, m.contact_id);
      const who = slackEscape(contactName(c));
      const url = `${app.baseUrl()}/app/conversations/${m.conversation_id}`;
      const body = String(m.body ?? '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim() || (m.subject ? '' : '(ohne Text)');
      const quote = slackQuote(`${m.subject ? `${m.subject}\n` : ''}${body}`);
      try {
        if (mode(a) === 'webhook') {
          await postWebhook(a, `:speech_balloon: *${who}* über *${label(m.channel)}*\n${quote}\n<${url}|Im CRM öffnen>`);
          return;
        }
        const thread = db.get('SELECT * FROM slack_threads WHERE location_id = ? AND conversation_id = ?', loc, m.conversation_id);
        if (thread && thread.slack_channel === a.config.channel) {
          await api(a, 'chat.postMessage', { channel: thread.slack_channel, thread_ts: thread.thread_ts, text: `*${who}* (${label(m.channel)}):\n${quote}`, unfurl_links: false });
          return;
        }
        const hint = a.secrets.signing_secret ? ` · _Im Thread antworten = an ${who} senden (// am Anfang bleibt intern)_` : '';
        const r = await api(a, 'chat.postMessage', { channel: a.config.channel, text: `:speech_balloon: *${who}* über *${label(m.channel)}*\n${quote}\n<${url}|Im CRM öffnen>${hint}`, unfurl_links: false });
        if (r?.ts) {
          db.run(
            `INSERT INTO slack_threads (location_id, conversation_id, slack_channel, thread_ts, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(location_id, conversation_id) DO UPDATE SET slack_channel = excluded.slack_channel, thread_ts = excluded.thread_ts, created_at = excluded.created_at`,
            loc, m.conversation_id, String(r.channel ?? a.config.channel), String(r.ts), now(),
          );
        }
      } catch (e) {
        noteError(app, loc, CH, `Weiterleitung an Slack fehlgeschlagen: ${(e as Error).message}`);
      }
    };
    app.events.on('message.inbound', (e) => forward(e.locationId, e.data));

    // --- Slack thread reply → customer -----------------------------------------------------------
    /** Which channel a reply goes out on: the one the customer last wrote on (calls do not count). */
    const replyChannel = (conversationId: string): string => {
      const lastIn = db.get(`SELECT channel FROM messages WHERE conversation_id = ? AND direction = 'in' AND channel NOT IN ('call', 'push') ORDER BY created_at DESC LIMIT 1`, conversationId);
      const last = db.get(`SELECT channel FROM messages WHERE conversation_id = ? AND channel NOT IN ('call', 'push') ORDER BY created_at DESC LIMIT 1`, conversationId);
      return String(lastIn?.channel ?? last?.channel ?? 'email');
    };

    const handleReply = async (a: ChannelAccount, ev: any) => {
      const loc = a.location_id;
      const thread = db.get('SELECT * FROM slack_threads WHERE location_id = ? AND slack_channel = ? AND thread_ts = ?', loc, String(ev.channel), String(ev.thread_ts));
      if (!thread) return;
      const text = fromSlack(String(ev.text ?? ''));
      if (!text || text.startsWith('//')) return;
      const conv = db.get('SELECT * FROM conversations WHERE id = ? AND location_id = ?', thread.conversation_id, loc);
      if (!conv) return;
      const channel = replyChannel(conv.id);
      let subject: string | undefined;
      if (channel === 'email') {
        const prev = db.get(`SELECT subject FROM messages WHERE conversation_id = ? AND channel = 'email' AND direction = 'in' AND subject != '' ORDER BY created_at DESC LIMIT 1`, conv.id)?.subject;
        subject = prev ? (/^(re|aw):/i.test(prev) ? prev : `Re: ${prev}`) : `Nachricht von ${app.location(loc)?.name ?? ''}`.trim();
      }
      let result: any;
      try {
        result = await channelSend(app, loc, { contactId: conv.contact_id, channel, body: text, subject, source: 'Slack' });
      } catch (e) {
        result = { status: 'failed', error: e instanceof HttpError ? e.message : (e as Error).message };
      }
      try {
        if (result?.status === 'failed') await api(a, 'chat.postMessage', { channel: thread.slack_channel, thread_ts: thread.thread_ts, text: `:warning: Nicht gesendet (${label(channel)}): ${slackEscape(String(result.error ?? 'unbekannter Fehler'))}` });
        else await api(a, 'reactions.add', { channel: thread.slack_channel, timestamp: String(ev.ts), name: 'white_check_mark' });
      } catch (e) {
        noteError(app, loc, CH, `Slack-Rückmeldung fehlgeschlagen: ${(e as Error).message}`);
      }
    };

    router.post('/hooks/slack/:loc', 'public', async (ctx) => {
      const a = getAccount(app, ctx.params.loc, CH);
      if (!a?.secrets.signing_secret) throw notFound();
      if (!verifySlack(ctx.rawBody, header(ctx.req.headers, 'x-slack-request-timestamp'), header(ctx.req.headers, 'x-slack-signature'), a.secrets.signing_secret)) throw new HttpError(401, 'Signatur ungültig');
      const b = ctx.body ?? {};
      // Slack checks the address once when it is entered under Event Subscriptions.
      if (b.type === 'url_verification') return { challenge: String(b.challenge ?? '').slice(0, 200) };
      noteWebhook(app, a.location_id, CH);
      if (b.type !== 'event_callback' || !a.enabled || mode(a) !== 'bot') return { ok: true };
      const ev = b.event ?? {};
      const isReply = ev.type === 'message' && !ev.subtype && !ev.bot_id && !ev.app_id && ev.thread_ts && ev.thread_ts !== ev.ts && ev.channel === a.config.channel;
      if (!isReply) return { ok: true };
      if (!firstSeen(app, a.location_id, CH, String(b.event_id || `${ev.channel}:${ev.ts}`))) return { ok: true, duplicate: true };
      try {
        await handleReply(a, ev);
      } catch (e) {
        console.error('[slack] reply failed', e);
        noteError(app, a.location_id, CH, `Antwort aus Slack fehlgeschlagen: ${(e as Error).message}`);
      }
      return { ok: true };
    });

    // --- settings ----------------------------------------------------------------------------
    router.get('/api/settings/channels/slack', 'location', (ctx) => out(ctx.locationId, getAccount(app, ctx.locationId, CH)));

    router.put('/api/settings/channels/slack', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      const cur = getAccount(app, ctx.locationId, CH);
      const config: Record<string, any> = {};
      if (b.mode !== undefined) config.mode = b.mode === 'webhook' ? 'webhook' : 'bot';
      if (b.channel !== undefined) {
        const c = str(b.channel, 'Kanal-ID', { max: 30 }).toUpperCase();
        if (c && !CHANNEL_ID.test(c)) throw bad('Kanal-ID wie C0123ABCD (Kanal → Details → ganz unten)');
        config.channel = c;
      }
      if (b.channels !== undefined) config.channels = (Array.isArray(b.channels) ? b.channels : []).map((x: unknown) => String(x)).filter((x: string) => /^[a-z]{2,20}$/.test(x)).slice(0, 20);
      const secrets: Record<string, string | null> = {};
      let info = cur?.info ?? {};
      for (const [k, re, msg] of [
        ['signing_secret', SIGNING_SECRET, 'Signing Secret: 32 Hex-Zeichen (Basic Information → App Credentials)'],
        ['webhook_url', null, 'Webhook-Adresse wie https://hooks.slack.com/services/…'],
      ] as const) {
        if (b[k] === null) secrets[k] = null;
        else if (b[k] !== undefined && b[k] !== '' && b[k] !== '••••••') {
          const v = str(b[k], k, { max: 300 });
          if (re ? !re.test(v) : !isSlackWebhook(v)) throw bad(msg);
          secrets[k] = v;
        }
      }
      if (b.bot_token === null) {
        secrets.bot_token = null;
        info = {};
      } else if (b.bot_token !== undefined && b.bot_token !== '' && b.bot_token !== '••••••') {
        const t = str(b.bot_token, 'Bot-Token', { max: 300 });
        if (!BOT_TOKEN.test(t)) throw bad('Bot-Token wie xoxb-… (OAuth & Permissions → Bot User OAuth Token)');
        try {
          const r = await slackCall(fetcher(), t, 'auth.test');
          info = { team: String(r.team ?? '').slice(0, 80), bot_user_id: String(r.user_id ?? ''), bot: String(r.user ?? '').slice(0, 80) };
        } catch (e) {
          throw bad(`Slack lehnt den Token ab: ${(e as Error).message}`);
        }
        secrets.bot_token = t;
      }
      return out(ctx.locationId, saveAccount(app, ctx.locationId, CH, { config, secrets, info, enabled: b.enabled === undefined ? undefined : !!b.enabled }));
    });

    router.delete('/api/settings/channels/slack', 'location', (ctx) => {
      deleteAccount(app, ctx.locationId, CH);
      return { ok: true };
    });

    router.post('/api/settings/channels/slack/test', 'location', async (ctx) => {
      const a = getAccount(app, ctx.locationId, CH);
      if (!ready(a)) throw bad('Slack ist noch nicht vollständig eingerichtet');
      const text = `:white_check_mark: Test von ${slackEscape(app.location(ctx.locationId)?.name ?? 'HyperLevel')}: Neue Nachrichten aus dem Posteingang erscheinen hier.`;
      try {
        if (mode(a) === 'webhook') await postWebhook(a, text);
        else await api(a, 'chat.postMessage', { channel: a.config.channel, text });
      } catch (e) {
        throw new HttpError(502, (e as Error).message);
      }
      noteError(app, ctx.locationId, CH, null);
      return { ok: true, info: mode(a) === 'webhook' ? 'Testnachricht gesendet' : `Testnachricht in ${a.config.channel}${a.info.team ? ` (${a.info.team})` : ''} gesendet` };
    });

    app.services.catalogExtra = [
      ...(app.services.catalogExtra ?? []),
      {
        entry: { key: 'slack', name: 'Slack (Team)', category: 'Kommunikation', icon: 'slack', scope: 'location', setup: { location: 'settings/more-channels' }, description: 'Neue Kundennachrichten als Thread in einem Slack-Kanal; Antworten im Thread gehen an den Kunden zurück.', credentials: 'Bot-Token (xoxb-…), Kanal-ID und Signing Secret – oder nur eine Incoming-Webhook-Adresse – unter Einstellungen → Weitere Kanäle.', docs: 'docs/channels.md#slack' },
        location: (_ctx: Ctx, loc: string) => {
          const a = getAccount(app, loc, CH);
          if (!ready(a)) return { status: 'missing', detail: 'Nicht eingerichtet' };
          if (a.last_error) return { status: 'partial', detail: `Fehler: ${a.last_error.slice(0, 80)}` };
          if (mode(a) === 'webhook') return { status: 'ok', detail: 'Benachrichtigungen per Webhook' };
          return a.secrets.signing_secret ? { status: 'ok', detail: `${a.info.team || 'Slack'} · Antworten aus Slack an` } : { status: 'partial', detail: 'Nur Benachrichtigungen – Signing Secret fehlt für Antworten' };
        },
      },
    ];
  },
};
