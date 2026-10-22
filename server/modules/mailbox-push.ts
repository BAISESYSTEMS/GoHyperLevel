import type { Module } from '../core/app.js';
import { HttpError, bad, notFound, str, text, type Ctx } from '../core/http.js';
import { openSecret, sealSecret } from '../core/secrets.js';
import { safeEqual, token } from '../core/util.js';
import { JwksCache } from '../services/jose.js';
import { gmailStop, gmailWatch } from '../services/mailbox-gmail.js';
import { graphRenew, graphSubscribe, graphUnsubscribe } from '../services/mailbox-graph.js';
import { canRead } from '../services/mailbox-kit.js';
import { parseGraphNotices, parsePubSub, verifyPubSubJwt } from '../services/mailbox-push.js';
import { getMailbox, kickSync, type MailboxRow } from '../services/mailbox-sync.js';
import { mailboxManageable } from '../services/mailbox-access.js';

/**
 * Push for native mailboxes, so mail shows up in seconds instead of at the next poll:
 * - Gmail: `users.watch` publishes to a Cloud Pub/Sub topic of the agency's Google Cloud project; a push
 *   subscription calls POST /hooks/mailbox/gmail, authenticated by a Google-signed OIDC token (audience and
 *   service account pinned in Agentur → Integrationen) or, without that, a shared secret in the URL.
 * - Microsoft Graph: a change-notification subscription per mailbox (POST /hooks/mailbox/graph): the validation
 *   handshake echoes `validationToken`, every notification must carry the subscription's `clientState`.
 * Subscriptions expire (Gmail 7 days, Graph 3) and are renewed in the background; where push is not possible
 * (no public https address, no Pub/Sub topic) the poll every few minutes keeps working.
 */

const KEY = 'mailbox_push';
const TOPIC = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][\w.~+%-]{2,254}$/;
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const RENEW_EVERY_MS = 30 * 60_000;
const GMAIL_RENEW_BEFORE_MS = 2 * 864e5;
const GRAPH_RENEW_BEFORE_MS = 24 * 3600_000;
const RETRY_REGISTER_MS = 6 * 3600_000;

interface PushConfig {
  gmail_topic: string;
  audience: string;
  service_account: string;
  secret: string;
}

export const mailboxPushModule: Module = {
  name: 'mailbox-push',
  register(app) {
    const { db, router } = app;
    const fetcher = (): typeof fetch => app.services.oauthFetch ?? fetch;
    const tokenFn = (mb: MailboxRow) => (force?: boolean) => app.services.oauth.token(mb.connection_id, force) as Promise<string>;

    // --- agency settings ---------------------------------------------------------------------------
    const read = (): Record<string, any> => {
      const row = db.get<{ value: string }>('SELECT value FROM agency_settings WHERE key = ?', KEY);
      return row ? JSON.parse(row.value) : {};
    };
    const write = (v: Record<string, any>) => db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(v));
    const config = (): PushConfig => {
      const s = read();
      let secret = '';
      if (s.secret) {
        try {
          secret = openSecret(app, s.secret);
        } catch {
          secret = '';
        }
      }
      return { gmail_topic: String(s.gmail_topic ?? process.env.PGHL_GMAIL_PUBSUB_TOPIC ?? ''), audience: String(s.audience ?? ''), service_account: String(s.service_account ?? ''), secret };
    };
    /** The shared secret exists from the first look at the settings on (it is part of the URL shown to the admin). */
    const ensureSecret = (): string => {
      const c = config();
      if (c.secret) return c.secret;
      const secret = token(24);
      write({ ...read(), secret: sealSecret(app, secret) });
      return secret;
    };
    const gmailUrl = () => `${app.baseUrl()}/hooks/mailbox/gmail`;
    const audienceOf = (c: PushConfig) => c.audience || gmailUrl();
    const publicHttps = () => {
      try {
        const u = new URL(app.baseUrl());
        return u.protocol === 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname) && !u.hostname.endsWith('.local');
      } catch {
        return false;
      }
    };
    const graphReady = () => publicHttps();
    const status = () => ({ gmail: !!config().gmail_topic, graph: graphReady() });

    const settingsOut = () => {
      const c = config();
      const secret = ensureSecret();
      return {
        gmail: {
          topic: c.gmail_topic,
          audience: c.audience,
          effective_audience: audienceOf(c),
          service_account: c.service_account,
          jwt_ready: !!(c.service_account && audienceOf(c)),
          push_url: `${gmailUrl()}?key=${secret}`,
          endpoint_url: gmailUrl(),
          ready: !!c.gmail_topic,
        },
        graph: { ready: graphReady(), notification_url: `${app.baseUrl()}/hooks/mailbox/graph`, lifecycle_url: `${app.baseUrl()}/hooks/mailbox/graph/lifecycle`, reason: graphReady() ? '' : 'HyperLevel braucht eine öffentliche https-Adresse (PGHL_BASE_URL), damit Microsoft Benachrichtigungen schicken kann.' },
        active: {
          gmail: Number(db.get(`SELECT COUNT(*) AS n FROM mailboxes WHERE json_extract(push, '$.kind') = 'gmail_watch' AND json_extract(push, '$.id') IS NOT NULL`)?.n ?? 0),
          graph: Number(db.get(`SELECT COUNT(*) AS n FROM mailboxes WHERE json_extract(push, '$.kind') = 'graph_subscription' AND json_extract(push, '$.id') IS NOT NULL`)?.n ?? 0),
        },
      };
    };
    router.get('/api/agency/mailbox-push', 'admin', () => settingsOut());
    router.put('/api/agency/mailbox-push', 'admin', (ctx) => {
      const b = ctx.body ?? {};
      const s = read();
      if (b.gmail_topic !== undefined) {
        const t = str(b.gmail_topic, 'Pub/Sub-Thema', { max: 300 });
        if (t && !TOPIC.test(t)) throw bad('Pub/Sub-Thema ungültig (projects/<projekt>/topics/<name>)');
        s.gmail_topic = t;
      }
      if (b.audience !== undefined) {
        const a = str(b.audience, 'Zielgruppe (audience)', { max: 300 });
        if (a && !/^[\x21-\x7e]+$/.test(a)) throw bad('Zielgruppe ungültig');
        s.audience = a;
      }
      if (b.service_account !== undefined) {
        const e = str(b.service_account, 'Dienstkonto', { max: 200 }).toLowerCase();
        if (e && !EMAIL.test(e)) throw bad('Dienstkonto ist keine E-Mail-Adresse (…@<projekt>.iam.gserviceaccount.com)');
        s.service_account = e;
      }
      if (b.rotate_secret) s.secret = sealSecret(app, token(24));
      write(s);
      return settingsOut();
    });

    // --- registering and renewing -----------------------------------------------------------------------
    const savePush = (id: string, push: Record<string, any>) => db.run('UPDATE mailboxes SET push = ? WHERE id = ?', JSON.stringify(push), id);

    async function stop(mailboxId: string): Promise<void> {
      const mb = getMailbox(app, mailboxId);
      if (!mb?.push?.id) return;
      try {
        if (mb.push.kind === 'gmail_watch') await gmailStop(fetcher(), tokenFn(mb));
        else if (mb.push.kind === 'graph_subscription') await graphUnsubscribe(fetcher(), tokenFn(mb), String(mb.push.id));
      } catch {
        /* the subscription expires by itself */
      }
      savePush(mailboxId, {});
    }

    /** Starts push for one mailbox. Failure is recorded on the mailbox ("nur Abruf alle 3 Minuten"), never thrown. */
    async function register(mailboxId: string): Promise<{ ok: boolean; error?: string }> {
      const mb = getMailbox(app, mailboxId);
      if (!mb || !mb.enabled || !canRead(mb.access)) return { ok: false, error: 'Postfach nicht bereit' };
      const fail = (error: string) => {
        savePush(mailboxId, { kind: mb.provider === 'google' ? 'gmail_watch' : 'graph_subscription', error, tried_at: new Date().toISOString() });
        return { ok: false, error };
      };
      try {
        if (mb.provider === 'google') {
          const c = config();
          if (!c.gmail_topic) return fail('Kein Pub/Sub-Thema eingetragen (Agentur → Integrationen)');
          const r = await gmailWatch(fetcher(), tokenFn(mb), c.gmail_topic, mb.folders);
          savePush(mailboxId, { kind: 'gmail_watch', id: 'watch', expires_at: r.expiresAt, registered_at: new Date().toISOString() });
          return { ok: true };
        }
        if (!graphReady()) return fail('Push braucht eine öffentliche https-Adresse');
        if (mb.push?.id && mb.push.kind === 'graph_subscription') await graphUnsubscribe(fetcher(), tokenFn(mb), String(mb.push.id)).catch(() => undefined);
        const clientState = token(24);
        const r = await graphSubscribe(fetcher(), tokenFn(mb), { shared: mb.shared_address, notificationUrl: `${app.baseUrl()}/hooks/mailbox/graph`, lifecycleUrl: `${app.baseUrl()}/hooks/mailbox/graph/lifecycle`, clientState });
        savePush(mailboxId, { kind: 'graph_subscription', id: r.id, expires_at: r.expiresAt, client_state: sealSecret(app, clientState), registered_at: new Date().toISOString() });
        return { ok: true };
      } catch (e) {
        return fail((e as Error).message.slice(0, 300));
      }
    }

    /** Renews what runs out soon and retries mailboxes that have no push yet (at most every few hours). */
    async function renewDue(): Promise<void> {
      const rows = db.all<{ id: string }>(`SELECT id FROM mailboxes WHERE enabled = 1 AND access != 'send'`);
      for (const r of rows) {
        const mb = getMailbox(app, r.id);
        if (!mb) continue;
        const left = mb.push?.expires_at ? Date.parse(mb.push.expires_at) - Date.now() : -1;
        if (mb.push?.id && mb.push.kind === 'graph_subscription') {
          if (left > GRAPH_RENEW_BEFORE_MS) continue;
          try {
            const res = await graphRenew(fetcher(), tokenFn(mb), String(mb.push.id));
            if (res) savePush(mb.id, { ...mb.push, expires_at: res.expiresAt });
            else await register(mb.id);
          } catch {
            await register(mb.id);
          }
        } else if (mb.push?.id && mb.push.kind === 'gmail_watch') {
          if (left > GMAIL_RENEW_BEFORE_MS) continue;
          await register(mb.id);
        } else {
          // No push yet: try again when it could work now (topic added, https address set).
          const tried = mb.push?.tried_at ? Date.parse(mb.push.tried_at) : 0;
          const possible = mb.provider === 'google' ? !!config().gmail_topic : graphReady();
          if (possible && Date.now() - tried > RETRY_REGISTER_MS && !/neu verbinden/.test(mb.last_error ?? '')) await register(mb.id);
        }
      }
    }
    let lastRenew = 0;
    app.onTick(async () => {
      if (Date.now() - lastRenew < RENEW_EVERY_MS) return;
      lastRenew = Date.now();
      await renewDue();
    });
    app.services.mailboxPush = { register, stop, renewDue, status };

    router.post('/api/mailboxes/:id/push', 'location', async (ctx) => {
      const mb = getMailbox(app, ctx.params.id);
      if (!mb || !mailboxManageable(ctx, mb)) throw notFound('Postfach nicht gefunden');
      if (ctx.body?.enable === false) {
        await stop(mb.id);
        return { ok: true, push: { active: false } };
      }
      const r = await register(mb.id);
      if (!r.ok) throw new HttpError(409, r.error ?? 'Push konnte nicht eingerichtet werden');
      const next = getMailbox(app, mb.id)!;
      return { ok: true, push: { active: true, kind: next.push.kind, expires_at: next.push.expires_at } };
    });

    // --- Gmail: Pub/Sub push ----------------------------------------------------------------------------------
    const jwks = new JwksCache(async (url) => {
      const r = await fetcher()(url, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`JWKS ${r.status}`);
      return r.json();
    });

    router.post('/hooks/mailbox/gmail', 'public', async (ctx: Ctx) => {
      const c = config();
      const bearer = /^Bearer\s+(.+)$/i.exec(String(ctx.req.headers.authorization ?? ''))?.[1];
      let authed = false;
      // Preferred: the OIDC token Pub/Sub signs for the push subscription's service account.
      if (bearer && c.service_account) {
        try {
          await verifyPubSubJwt(bearer, { jwks, audience: audienceOf(c), serviceAccount: c.service_account });
          authed = true;
        } catch {
          authed = false;
        }
      }
      // Fallback: a long random secret in the push URL (compared in constant time).
      const key = ctx.query.get('key');
      if (!authed && key && c.secret && safeEqual(key, c.secret)) authed = true;
      if (!authed) throw new HttpError(401, 'Nicht berechtigt');
      const notice = parsePubSub(ctx.body);
      // Acknowledged either way: Pub/Sub would redeliver a message we cannot use forever.
      if (!notice) return { ok: true, ignored: true };
      const rows = db.all<{ id: string }>(`SELECT id FROM mailboxes WHERE provider = 'google' AND enabled = 1 AND access != 'send' AND address = ?`, notice.address);
      for (const r of rows) kickSync(app, r.id);
      return { ok: true, mailboxes: rows.length };
    });

    // --- Microsoft Graph: change notifications -------------------------------------------------------------------
    const graphHook = async (ctx: Ctx) => {
      // Validation handshake when a subscription is created: echo the token as plain text within 10 seconds.
      const validation = ctx.query.get('validationToken');
      if (validation !== null) return text(validation, 'text/plain; charset=utf-8');
      const notices = parseGraphNotices(ctx.body);
      let accepted = 0;
      let rejected = 0;
      for (const n of notices) {
        const mb = db.get<any>(`SELECT id FROM mailboxes WHERE json_extract(push, '$.kind') = 'graph_subscription' AND json_extract(push, '$.id') = ?`, n.subscriptionId);
        const full = mb ? getMailbox(app, mb.id) : undefined;
        let expected = '';
        try {
          expected = full?.push?.client_state ? openSecret(app, String(full.push.client_state)) : '';
        } catch {
          expected = '';
        }
        // A notification without the clientState we chose is not from Microsoft (or not for this subscription).
        if (!full || !expected || !safeEqual(n.clientState, expected)) {
          rejected++;
          continue;
        }
        accepted++;
        if (n.lifecycleEvent === 'reauthorizationRequired') {
          void graphRenew(fetcher(), tokenFn(full), String(full.push.id)).then((r) => r && savePush(full.id, { ...full.push, expires_at: r.expiresAt })).catch(() => undefined);
        } else if (n.lifecycleEvent === 'subscriptionRemoved') {
          savePush(full.id, {});
          void register(full.id);
        } else kickSync(app, full.id); // a change, or "missed" (notifications were lost): read now
      }
      if (notices.length && !accepted && rejected) throw new HttpError(401, 'clientState stimmt nicht');
      return { __raw: true, status: 202, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, accepted }) };
    };
    router.post('/hooks/mailbox/graph', 'public', graphHook);
    router.post('/hooks/mailbox/graph/lifecycle', 'public', graphHook);
  },
};
