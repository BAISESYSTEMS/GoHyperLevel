import { SESSION_COOKIE, type App, type Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, num, str, type Ctx, type User } from '../core/http.js';
import { id, now, sha256, token } from '../core/util.js';
import { OAuthError, PROVIDER_LABEL, STATE_TTL_MS, authorizeUrl, exchangeCode, idTokenClaims, pkcePair, revokeToken, signState, type Provider } from '../services/oauth.js';
import { mailboxManageable, mayUseMailbox, visibleMailboxes } from '../services/mailbox-access.js';
import { actOnConversation, conversationFilter, decorateConversations, decorateMessages } from '../services/mailbox-actions.js';
import { gmailApi } from '../services/mailbox-gmail.js';
import { graphApi } from '../services/mailbox-graph.js';
import { MAIL_ACCESS, MailError, EMAIL, canModify, canRead, mailScopes, missingMailScopes, type MailAccess } from '../services/mailbox-kit.js';
import { mailboxOut } from '../services/mailbox-out.js';
import { apiFor, flushOutbox, getMailbox, ownerMayUse, queueDraftDelete, syncDue, syncMailbox, type MailboxRow } from '../services/mailbox-sync.js';
import { mailboxMailModule } from './mailbox-mail.js';
import { mailboxPushModule } from './mailbox-push.js';
import { clientConfig, canManageLocation, redirectUriFor } from './oauth-connect.js';
import { openSecret, sealSecret } from './mail-sync.js';

/**
 * Native mailboxes: Gmail and Outlook / Microsoft 365 through their official APIs instead of IMAP/SMTP.
 * Connecting uses the agency's Google/Microsoft OAuth app (modules/oauth-connect.ts: PKCE, signed state, sealed
 * tokens that refresh by themselves); a mailbox belongs to a sub-account or to one person (routing rules decide
 * which sub-account a personal mailbox's mail goes to). This module owns the tables, the connect flow, the
 * mailbox settings and the background sync; `mailbox-mail.ts` is the inbox side (threads, send, drafts, search,
 * MCP tools) and `mailbox-push.ts` the push channels (Gmail Pub/Sub watch, Graph change notifications).
 */

const RETURN_TO = '/app/settings/messaging';
const FIELD_LABEL: Record<string, string> = { address: 'Adresse', domain: 'Domain', subject: 'Betreff', any: 'Irgendwo' };

export const mailboxesModule: Module = {
  name: 'mailboxes',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mailboxes (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        scope TEXT NOT NULL,
        location_id TEXT REFERENCES locations(id) ON DELETE CASCADE,
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        shared_address TEXT NOT NULL DEFAULT '',
        access TEXT NOT NULL DEFAULT 'full',
        enabled INTEGER NOT NULL DEFAULT 1,
        window_days INTEGER NOT NULL DEFAULT 90,
        folders TEXT NOT NULL DEFAULT '[]',
        rules TEXT NOT NULL DEFAULT '[]',
        default_location_id TEXT,
        contact_policy TEXT NOT NULL DEFAULT 'all',
        skip_promotions INTEGER NOT NULL DEFAULT 1,
        trigger_workflows INTEGER NOT NULL DEFAULT 1,
        signature TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT '{}',
        push TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'new',
        last_sync_at TEXT, last_error TEXT, last_result TEXT,
        sync_due INTEGER NOT NULL DEFAULT 1,
        next_sync_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX mailboxes_loc ON mailboxes(location_id);
      CREATE INDEX mailboxes_owner ON mailboxes(owner_user_id);
      CREATE INDEX mailboxes_address ON mailboxes(provider, address);
      CREATE INDEX mailboxes_due ON mailboxes(enabled, sync_due, next_sync_at);

      CREATE TABLE mailbox_messages (
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        remote_id TEXT NOT NULL,
        location_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        internet_id TEXT NOT NULL DEFAULT '',
        refs TEXT NOT NULL DEFAULT '',
        folder TEXT NOT NULL DEFAULT 'inbox',
        folder_id TEXT NOT NULL DEFAULT '',
        labels TEXT NOT NULL DEFAULT '[]',
        unread INTEGER NOT NULL DEFAULT 0,
        starred INTEGER NOT NULL DEFAULT 0,
        draft_id TEXT NOT NULL DEFAULT '',
        attachments TEXT NOT NULL DEFAULT '[]',
        addrs TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL,
        PRIMARY KEY (mailbox_id, remote_id)
      );
      CREATE INDEX mailbox_messages_msg ON mailbox_messages(message_id);
      CREATE INDEX mailbox_messages_conv ON mailbox_messages(conversation_id, location_id);
      CREATE INDEX mailbox_messages_internet ON mailbox_messages(location_id, internet_id) WHERE internet_id != '';
      CREATE INDEX mailbox_messages_box ON mailbox_messages(mailbox_id, folder);
      CREATE INDEX mailbox_messages_draft ON mailbox_messages(mailbox_id, draft_id) WHERE draft_id != '';

      CREATE TABLE mailbox_pending (
        nonce TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        location_id TEXT,
        access TEXT NOT NULL,
        shared_address TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        mailbox_id TEXT,
        scopes TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE mailbox_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        op TEXT NOT NULL,
        ref TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX mailbox_outbox_box ON mailbox_outbox(mailbox_id, ref);

      CREATE TABLE mailbox_scheduled (
        id TEXT PRIMARY KEY,
        mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL,
        user_id TEXT,
        send_at TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX mailbox_scheduled_due ON mailbox_scheduled(status, send_at);
      CREATE INDEX mailbox_scheduled_loc ON mailbox_scheduled(location_id, status);
      `,
    ],
    [
      // Opt-in: mail sent from this mailbox in HyperLevel gets the open pixel and tracked links (off by default – 1:1 mail may need consent).
      '002-track-engagement',
      `ALTER TABLE mailboxes ADD COLUMN track_engagement INTEGER NOT NULL DEFAULT 0;`,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = (): typeof fetch => app.services.oauthFetch ?? fetch;
    const audit = (ctx: Ctx | undefined, action: string, summary: string, mb: Pick<MailboxRow, 'id' | 'location_id'>) => app.services.audit?.({ ctx, action, summary: summary.slice(0, 300), locationId: mb.location_id ?? ctx?.locationId ?? null, entityId: mb.id });

    const session = (ctx: Ctx) => {
      if (ctx.via !== 'session' || !ctx.user) throw new HttpError(403, 'Das geht nur angemeldet im Browser');
    };
    /** The mailbox for a management call (settings, disconnect…): visible to the caller, and manageable. */
    const manageOf = (ctx: Ctx): MailboxRow => {
      session(ctx);
      const mb = getMailbox(app, ctx.params.id);
      if (!mb || !mailboxManageable(ctx, mb)) throw notFound('Postfach nicht gefunden');
      return mb;
    };

    // --- OAuth: the provider sends the browser back to the shared callback, which hands "mail" over to us ------------
    const pendingScopes = (access: MailAccess, provider: Provider, shared: boolean) => mailScopes(provider, access, shared);

    router.post('/api/mailboxes/connect', 'location', (ctx) => {
      session(ctx);
      const provider = String(ctx.body.provider ?? '') as Provider;
      if (provider !== 'google' && provider !== 'microsoft') throw bad('Unbekannter Anbieter');
      const scope = ctx.body.scope === 'user' ? 'user' : 'location';
      const access = String(ctx.body.access ?? 'full') as MailAccess;
      if (!MAIL_ACCESS.includes(access)) throw bad('Unbekannte Zugriffsstufe');
      const shared = str(ctx.body.shared_address, 'Gemeinsames Postfach', { max: 200 }).toLowerCase();
      if (shared && (provider !== 'microsoft' || !EMAIL.test(shared))) throw bad(provider === 'microsoft' ? 'Adresse des gemeinsamen Postfachs ungültig' : 'Gemeinsame Postfächer gibt es nur bei Microsoft');
      if (scope === 'location' && !canManageLocation(ctx.user, ctx.locationId)) throw new HttpError(403, 'Kein Zugriff auf die Einstellungen dieses Sub-Accounts');
      let reconnect: MailboxRow | undefined;
      if (ctx.body.mailbox_id) {
        reconnect = getMailbox(app, String(ctx.body.mailbox_id));
        if (!reconnect || !mailboxManageable(ctx, reconnect)) throw notFound('Postfach nicht gefunden');
      }
      const cfg = clientConfig(app, provider);
      if (!cfg) throw new HttpError(409, `Die Agentur hat noch keine ${PROVIDER_LABEL[provider]}-App hinterlegt (Agentur → Integrationen)`);
      const sid = ctx.cookies[SESSION_COOKIE];
      if (!sid) throw new HttpError(403, 'Verbinden geht nur angemeldet im Browser');
      // Come back on the address the person is signed in on (main address or agency domain).
      const host = String(ctx.req.headers.host ?? '').toLowerCase();
      const origins = [app.config.baseUrl.replace(/\/$/, ''), ...(app.services.publicBaseUrl?.() ? [String(app.services.publicBaseUrl()).replace(/\/$/, '')] : [])];
      const origin = origins.find((o) => new URL(o).host === host) ?? app.baseUrl();
      const redirectUri = redirectUriFor(origin, provider);
      const nonce = token(18);
      const { verifier, challenge } = pkcePair();
      const scopes = pendingScopes(reconnect?.access ?? access, provider, !!(reconnect?.shared_address ?? shared));
      const loc = scope === 'location' ? ctx.locationId : null;
      db.run('DELETE FROM oauth_pending WHERE expires_at < ?', now());
      db.run('DELETE FROM mailbox_pending WHERE expires_at < ?', now());
      const expires = new Date(Date.now() + STATE_TTL_MS).toISOString();
      db.insert('oauth_pending', { nonce, provider, purpose: 'mail', user_id: ctx.user!.id, location_id: loc, verifier, redirect_uri: redirectUri, return_to: RETURN_TO, expires_at: expires });
      db.insert('mailbox_pending', { nonce, user_id: ctx.user!.id, scope, location_id: loc, access: reconnect?.access ?? access, shared_address: reconnect?.shared_address ?? shared, name: str(ctx.body.name, 'Name', { max: 100 }), mailbox_id: reconnect?.id ?? null, scopes, expires_at: expires });
      const state = signState(app.config.secret, { n: nonce, p: provider, k: 'mail', u: ctx.user!.id, s: sha256(sid), ...(loc ? { l: loc } : {}), e: Date.now() + STATE_TTL_MS });
      const hint = reconnect ? reconnect.address : ctx.body.login_hint ? String(ctx.body.login_hint).slice(0, 200) : undefined;
      return { url: authorizeUrl(provider, cfg, { redirectUri, scopes, state, challenge, loginHint: hint }) };
    });

    /** Called by the shared /oauth/:provider/callback for purpose "mail", after the state and the pending flow were checked. */
    async function callback(a: { ctx: Ctx; user: any; provider: Provider; pending: any; back: (p: Record<string, string>) => unknown }) {
      const { ctx, provider, pending, back } = a;
      const mp = db.get<any>('SELECT * FROM mailbox_pending WHERE nonce = ?', pending.nonce);
      db.run('DELETE FROM mailbox_pending WHERE nonce = ?', pending.nonce);
      if (!mp || mp.user_id !== a.user.id || Date.parse(mp.expires_at) < Date.now()) return back({ oauth: 'error', msg: 'Die Anmeldung ist abgelaufen oder wurde schon benutzt – bitte noch einmal verbinden' });
      if (ctx.query.get('error')) {
        const denied = ctx.query.get('error') === 'access_denied';
        return back({ oauth: 'error', msg: denied ? 'Zugriff wurde nicht erlaubt' : `${PROVIDER_LABEL[provider]}: ${String(ctx.query.get('error_description') || ctx.query.get('error')).slice(0, 200)}` });
      }
      const code = String(ctx.query.get('code') ?? '');
      if (!code) return back({ oauth: 'error', msg: 'Kein Code erhalten' });
      const cfg = clientConfig(app, provider);
      if (!cfg) return back({ oauth: 'error', msg: `Die ${PROVIDER_LABEL[provider]}-App der Agentur fehlt` });
      const user: User = { id: a.user.id, email: a.user.email, name: a.user.name, role: a.user.role, locations: JSON.parse(a.user.locations || '[]'), permissions: a.user.permissions ? JSON.parse(a.user.permissions) : null };
      try {
        if (mp.scope === 'location' && (!mp.location_id || !app.location(mp.location_id) || !canManageLocation(user, mp.location_id))) throw new Error('Kein Zugriff auf diesen Sub-Account');
        const t = await exchangeCode(fetcher(), provider, cfg, { code, verifier: pending.verifier, redirectUri: pending.redirect_uri, scopes: JSON.parse(mp.scopes) });
        const missing = t.scope ? missingMailScopes(provider, mp.access, !!mp.shared_address, t.scope) : [];
        if (missing.length) {
          await revokeToken(fetcher(), provider, cfg, t.refresh_token ?? t.access_token);
          return back({ oauth: 'error', msg: `Bitte beim Verbinden alle Berechtigungen für E-Mails erlauben (${mp.access === 'full' ? 'lesen, senden und verwalten' : mp.access === 'readonly' ? 'lesen' : 'senden'})` });
        }
        if (!t.refresh_token) return back({ oauth: 'error', msg: `${PROVIDER_LABEL[provider]} hat keinen dauerhaften Zugriff erteilt – bitte noch einmal verbinden` });
        const claims = idTokenClaims(t.id_token);
        // The mailbox's own address: the shared mailbox that was asked for, else the account that signed in.
        const probe = provider === 'google' ? gmailApi(fetcher(), async () => t.access_token) : graphApi(fetcher(), async () => t.access_token, mp.shared_address);
        let address = mp.shared_address || claims.email.toLowerCase();
        if (!address && canRead(mp.access)) address = (await probe.profile()).address;
        if (!address) throw new Error('Die E-Mail-Adresse des Postfachs konnte nicht ermittelt werden');
        // A shared mailbox must really be reachable with this login.
        if (mp.shared_address && canRead(mp.access)) {
          try {
            await probe.folders();
          } catch (e) {
            if (e instanceof MailError && (e.status === 403 || e.status === 404)) throw new Error(`Kein Zugriff auf das gemeinsame Postfach ${mp.shared_address} – Vollzugriff bzw. „Senden als“ im Exchange-Admin-Center erteilen`);
            throw e;
          }
        }
        const tokens = { access_token: sealSecret(app, t.access_token), refresh_token: sealSecret(app, t.refresh_token), expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), scopes: t.scope.slice(0, 2000), status: 'ok', last_error: null, updated_at: now() };
        const mine = (mp.scope === 'location' ? `scope = 'location' AND location_id = ?` : `scope = 'user' AND owner_user_id = ?`);
        const existing: MailboxRow | undefined = mp.mailbox_id
          ? getMailbox(app, mp.mailbox_id)
          : (parseJson(db.get(`SELECT * FROM mailboxes WHERE ${mine} AND provider = ? AND address = ? AND shared_address = ?`, mp.scope === 'location' ? mp.location_id : user.id, provider, address, mp.shared_address), ['folders', 'rules', 'state', 'push', 'last_result']) as MailboxRow | undefined);
        if (mp.mailbox_id && (!existing || existing.address !== address)) throw new Error(`Das Konto ${address} ist nicht das Konto dieses Postfachs (${existing?.address ?? ''}) – bitte mit demselben Konto verbinden`);
        let mailboxId: string;
        if (existing) {
          // Same mailbox again: new tokens, everything else (rules, folders, sync state) stays.
          db.update('oauth_connections', existing.connection_id, { ...tokens, account_name: claims.name || undefined });
          db.run(`UPDATE mailboxes SET access = ?, status = 'new', last_error = NULL, sync_due = 1, next_sync_at = NULL, enabled = 1, updated_at = ? WHERE id = ?`, mp.access, now(), existing.id);
          mailboxId = existing.id;
        } else {
          const cid = id();
          db.insert('oauth_connections', { id: cid, provider, purpose: 'mail', user_id: user.id, location_id: mp.scope === 'location' ? mp.location_id : null, account_email: claims.email || address, account_name: claims.name, settings: {}, state: {}, created_at: now(), ...tokens });
          mailboxId = id();
          db.insert('mailboxes', {
            id: mailboxId,
            connection_id: cid,
            provider,
            scope: mp.scope,
            location_id: mp.scope === 'location' ? mp.location_id : null,
            owner_user_id: user.id,
            name: mp.name || (mp.shared_address ? `${mp.shared_address}` : address),
            address,
            shared_address: mp.shared_address,
            access: mp.access,
            created_at: now(),
            updated_at: now(),
          });
        }
        const mb = getMailbox(app, mailboxId)!;
        audit(ctx, existing ? 'mailbox.reconnect' : 'mailbox.connect', `${PROVIDER_LABEL[provider]}: ${mb.shared_address || mb.address} (${mp.access})`, mb);
        // First import and push run in the background; the page shows "wird importiert".
        setImmediate(() => {
          void (async () => {
            await app.services.mailboxPush?.register(mailboxId).catch(() => undefined);
            await syncMailbox(app, mailboxId, { maxMessages: 150, deadlineMs: 8_000 }).catch(() => undefined);
          })();
        });
        return back({ oauth: 'ok', provider, mailbox: mailboxId });
      } catch (e) {
        return back({ oauth: 'error', msg: (e as Error).message.slice(0, 300) });
      }
    }
    app.services.oauthPurposes = { ...(app.services.oauthPurposes ?? {}), mail: { callback } };

    // --- list and settings ----------------------------------------------------------------------------------
    const locationsFor = (ctx: Ctx) => {
      const rows = db.all<{ id: string; name: string }>('SELECT id, name FROM locations ORDER BY name');
      return ctx.user?.role === 'admin' ? rows : rows.filter((l) => ctx.user?.locations.includes(l.id));
    };
    router.get('/api/mailboxes', 'location', (ctx) => ({
      mailboxes: visibleMailboxes(app, ctx).map((mb) => mailboxOut(app, mb, ctx)),
      providers: { google: !!clientConfig(app, 'google'), microsoft: !!clientConfig(app, 'microsoft') },
      push: app.services.mailboxPush?.status() ?? { gmail: false, graph: false },
      locations: locationsFor(ctx),
      can_manage_location: canManageLocation(ctx.user, ctx.locationId),
    }));

    const cleanRules = (mb: MailboxRow, v: unknown) => {
      if (!Array.isArray(v)) throw bad('Regeln als Liste');
      return v.slice(0, 200).map((r: any) => {
        if (!Object.keys(FIELD_LABEL).includes(r?.field)) throw bad('Regel: Feld unbekannt');
        const loc = String(r.location_id ?? '');
        if (!app.location(loc) || !ownerMayUse(app, mb.owner_user_id, loc)) throw bad('Regel: Sub-Account nicht gefunden oder kein Zugriff');
        return { field: r.field, value: str(r.value, 'Regel-Wert', { required: true, max: 200 }), location_id: loc };
      });
    };

    router.patch('/api/mailboxes/:id', 'location', (ctx) => {
      const mb = manageOf(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      let reimport = false;
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 100 });
      if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
      if (b.window_days !== undefined) {
        const days = Math.min(365, Math.max(1, Math.floor(num(b.window_days, 90))));
        if (days > mb.window_days) reimport = true;
        patch.window_days = days;
      }
      if (b.folders !== undefined) {
        if (!Array.isArray(b.folders) || b.folders.length > 100) throw bad('Ordner als Liste (höchstens 100)');
        const list = [...new Set(b.folders.map((f: unknown) => String(f).slice(0, 300)).filter(Boolean))];
        if (JSON.stringify(list) !== JSON.stringify(mb.folders)) reimport = true;
        patch.folders = JSON.stringify(list);
      }
      if (b.rules !== undefined) {
        if (mb.scope !== 'user') throw bad('Regeln gibt es nur bei persönlichen Postfächern – ein Sub-Account-Postfach gehört immer seinem Sub-Account');
        patch.rules = JSON.stringify(cleanRules(mb, b.rules));
      }
      if (b.default_location_id !== undefined) {
        if (mb.scope !== 'user') throw bad('Ein Standard-Sub-Account gibt es nur bei persönlichen Postfächern');
        const loc = b.default_location_id ? String(b.default_location_id) : '';
        if (loc && (!app.location(loc) || !ownerMayUse(app, mb.owner_user_id, loc))) throw bad('Sub-Account nicht gefunden oder kein Zugriff');
        patch.default_location_id = loc || null;
      }
      if (b.contact_policy !== undefined) {
        if (b.contact_policy !== 'all' && b.contact_policy !== 'known') throw bad('Kontakt-Regel: all oder known');
        patch.contact_policy = b.contact_policy;
      }
      if (b.skip_promotions !== undefined) patch.skip_promotions = b.skip_promotions ? 1 : 0;
      if (b.trigger_workflows !== undefined) patch.trigger_workflows = b.trigger_workflows ? 1 : 0;
      if (b.signature !== undefined) patch.signature = str(b.signature, 'Signatur', { max: 2000 });
      if (b.track_engagement !== undefined && !!b.track_engagement !== !!mb.track_engagement) {
        patch.track_engagement = b.track_engagement ? 1 : 0;
        audit(ctx, 'mailbox.tracking', `${mb.shared_address || mb.address}: Öffnungen und Klicks ${b.track_engagement ? 'werden verfolgt' : 'werden nicht verfolgt'}`, mb);
      }
      if (reimport) {
        // A new folder or a longer window needs a fresh read (known mail is recognised, nothing is duplicated).
        patch.state = JSON.stringify({});
        patch.sync_due = 1;
        patch.next_sync_at = null;
      }
      const keys = Object.keys(patch);
      db.run(`UPDATE mailboxes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...(keys.map((k) => patch[k]) as any[]), mb.id);
      if (b.enabled === false) void app.services.mailboxPush?.stop(mb.id).catch(() => undefined);
      if (b.enabled === true) void app.services.mailboxPush?.register(mb.id).catch(() => undefined);
      return mailboxOut(app, getMailbox(app, mb.id)!, ctx);
    });

    router.delete('/api/mailboxes/:id', 'location', async (ctx) => {
      const mb = manageOf(ctx);
      const conn = db.get<{ refresh_token: string | null; access_token: string | null }>('SELECT refresh_token, access_token FROM oauth_connections WHERE id = ?', mb.connection_id);
      await app.services.mailboxPush?.stop(mb.id).catch(() => undefined);
      let revoked = false;
      const cfg = clientConfig(app, mb.provider);
      // Each mailbox has its own grant: it is revoked at Google (Microsoft has no way to revoke a single token).
      if (cfg && conn) {
        const tok = conn.refresh_token ? openSecret(app, conn.refresh_token) : conn.access_token ? openSecret(app, conn.access_token) : '';
        revoked = await revokeToken(fetcher(), mb.provider, cfg, tok);
      }
      // Deleting the connection removes the mailbox, its mapping and queue; the mail in the conversations stays.
      db.run('DELETE FROM oauth_connections WHERE id = ?', mb.connection_id);
      audit(ctx, 'mailbox.disconnect', `${PROVIDER_LABEL[mb.provider]}: ${mb.shared_address || mb.address}`, mb);
      return { ok: true, revoked };
    });

    router.post('/api/mailboxes/:id/sync', 'location', async (ctx) => {
      const mb = getMailbox(app, ctx.params.id);
      // Whoever may use the mailbox may ask for a sync (a send-only mailbox has nothing to read, but clears its status).
      if (!mb || !(mayUseMailbox(ctx, mb, 'read') || mayUseMailbox(ctx, mb, 'send'))) throw notFound('Postfach nicht gefunden');
      if (ctx.body?.full) session(ctx);
      try {
        const result = await syncMailbox(app, mb.id, { maxMessages: 500, deadlineMs: 25_000, full: !!ctx.body?.full });
        return { result, mailbox: mailboxOut(app, getMailbox(app, mb.id)!, ctx) };
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, `Postfach: ${(e as Error).message}`);
      }
    });

    router.get('/api/mailboxes/:id/folders', 'location', async (ctx) => {
      const mb = manageOf(ctx);
      if (!canRead(mb.access)) return { folders: [], labels: [], selected: [] };
      try {
        const api = apiFor(app, mb);
        const { folders, state } = await api.folders(mb.state);
        // Remember Graph's well-known folder ids (the sync needs them).
        if (state?.wk && !mb.state?.wk) db.run('UPDATE mailboxes SET state = ? WHERE id = ?', JSON.stringify({ ...mb.state, wk: state.wk }), mb.id);
        const labels = canModify(mb.access) ? await api.labels().catch(() => []) : [];
        return { folders, labels, selected: mb.folders };
      } catch (e) {
        if (e instanceof OAuthError) throw new HttpError(409, e.needsReconnect ? 'Zugriff abgelaufen oder entzogen – bitte neu verbinden' : e.message);
        throw new HttpError(502, `Postfach: ${(e as Error).message}`);
      }
    });

    // --- hooks into the inbox: filters, folder badges, flags that go back to the provider ------------------------
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    app.services.conversationFilters = [...list<unknown>(app.services.conversationFilters), (ctx: Ctx, where: string[], params: unknown[]) => conversationFilter(app, ctx, where, params)];
    app.services.conversationRows = [...list<unknown>(app.services.conversationRows), (ctx: Ctx, rows: any[]) => decorateConversations(app, ctx, rows)];
    app.services.messageRows = [...list<unknown>(app.services.messageRows), (ctx: Ctx, conversationId: string, rows: any[]) => decorateMessages(app, ctx, conversationId, rows)];

    const flushLater = (mailboxes: string[]) => {
      for (const m of mailboxes) void flushOutbox(app, m).catch(() => undefined);
    };
    // Opening a conversation marks its mail as read at Gmail / Outlook too.
    app.afterRead.push((ctx, route) => {
      if (route.pattern !== '/api/conversations/:id/messages' || ctx.viaApiKey) return;
      flushLater(actOnConversation(app, ctx, ctx.params.id, { kind: 'read', read: true }).mailboxes);
    });
    app.afterWrite.push((ctx, route) => {
      // "Ungelesen" and the star on a conversation.
      if (route.pattern === '/api/conversations/:id' && ctx.method === 'PATCH') {
        const m = new Set<string>();
        if (ctx.body?.unread !== undefined) for (const x of actOnConversation(app, ctx, ctx.params.id, { kind: 'read', read: !ctx.body.unread }).mailboxes) m.add(x);
        if (ctx.body?.starred !== undefined) for (const x of actOnConversation(app, ctx, ctx.params.id, { kind: 'star', starred: !!ctx.body.starred }).mailboxes) m.add(x);
        flushLater([...m]);
      }
      // A draft deleted in the inbox is deleted in the mailbox too.
      if (route.pattern === '/api/messages/:id' && ctx.method === 'DELETE') {
        const rows = db.all<{ mailbox_id: string; remote_id: string; draft_id: string }>(`SELECT mailbox_id, remote_id, draft_id FROM mailbox_messages WHERE message_id = ? AND location_id = ? AND folder = 'drafts'`, ctx.params.id, ctx.locationId);
        const boxes = new Set<string>();
        for (const r of rows) {
          const mb = getMailbox(app, r.mailbox_id);
          if (mb && mayUseMailbox(ctx, mb, 'send')) {
            queueDraftDelete(app, mb.id, { id: r.remote_id, draftId: r.draft_id });
            boxes.add(mb.id);
          }
          db.run('DELETE FROM mailbox_messages WHERE mailbox_id = ? AND remote_id = ?', r.mailbox_id, r.remote_id);
        }
        flushLater([...boxes]);
      }
    });

    // GDPR: erasing a contact drops the mapping of its mail (the mail in the mailbox itself is the owner's).
    app.services.privacyErase = [
      ...list<unknown>(app.services.privacyErase),
      (a: App, locationId: string, contact: { id: string }) => {
        a.db.run('DELETE FROM mailbox_messages WHERE location_id = ? AND message_id IN (SELECT id FROM messages WHERE contact_id = ? AND location_id = ?)', locationId, contact.id, locationId);
      },
    ];

    // --- status in the integrations catalogue -----------------------------------------------------------------
    const probe = (loc: string) => {
      const rows = db.all<MailboxRow>('SELECT * FROM mailboxes WHERE scope = ? AND location_id = ?', 'location', loc);
      if (!rows.length) return { status: 'missing' as const, detail: 'Kein Postfach verbunden' };
      const bad = rows.filter((r) => r.status === 'error');
      if (bad.length) return { status: 'partial' as const, detail: `${bad[0].shared_address || bad[0].address}: ${(bad[0].last_error ?? 'Fehler').slice(0, 80)}` };
      return { status: 'ok' as const, detail: `${rows.length} ${rows.length === 1 ? 'Postfach' : 'Postfächer'} (${rows.map((r) => (r.provider === 'google' ? 'Gmail' : 'Outlook')).join(', ')})` };
    };
    app.services.catalogExtra = [
      ...list<unknown>(app.services.catalogExtra),
      {
        entry: {
          key: 'mailbox_sync',
          name: 'Postfach-Sync: Gmail & Outlook',
          category: 'Kommunikation',
          icon: 'email',
          scope: 'both',
          setup: { location: 'settings/messaging', agency: 'agency/integrations' },
          description: 'Posteingang, Gesendet und Entwürfe über die offiziellen Gmail- und Microsoft-Graph-Schnittstellen, Antworten aus HyperLevel über das eigene Postfach, Archivieren und Labels in beide Richtungen.',
          credentials: 'Google-/Microsoft-OAuth-App der Agentur (Agentur → Integrationen); verbinden unter Einstellungen → E-Mail & SMS → Postfach verbinden. Push optional über Pub/Sub bzw. Graph-Benachrichtigungen.',
          docs: 'docs/mailbox-sync.md',
        },
        location: (_ctx: Ctx, loc: string) => probe(loc),
        agency: () => {
          const n = Number(db.get('SELECT COUNT(*) AS n FROM mailboxes')?.n ?? 0);
          return { status: n ? ('ok' as const) : ('info' as const), detail: n ? `${n} ${n === 1 ? 'Postfach' : 'Postfächer'} verbunden` : 'Bereit – Postfach unter Einstellungen verbinden' };
        },
      },
    ];

    // --- background: queued changes and the sync of every mailbox whose time has come ---------------------------
    app.onTick(async () => {
      await flushOutbox(app).catch(() => undefined);
      await syncDue(app);
    });

    app.services.mailbox = {
      get: (mid: string) => getMailbox(app, mid),
      sync: (mid: string, opts?: Parameters<typeof syncMailbox>[2]) => syncMailbox(app, mid, opts),
      flush: (mid?: string) => flushOutbox(app, mid),
      out: (mb: MailboxRow) => mailboxOut(app, mb),
    };
  },
};

export const mailboxModules: Module[] = [mailboxesModule, mailboxPushModule, mailboxMailModule];
