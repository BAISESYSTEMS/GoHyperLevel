import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { HttpError, bad, notFound, str, text, type Ctx, type RawResult } from '../core/http.js';
import { render } from '../core/template.js';
import { id, normalizePhone, now, token } from '../core/util.js';
import { getContact, logActivity, upsertContact, type Contact } from '../services/contacts.js';
import { getOrCreateConversation } from '../services/messaging.js';
import {
  CHANNEL_LABEL,
  DEFAULT_GRAPH_VERSION,
  META_CHANNELS,
  MetaApiError,
  TEXT_LIMITS,
  WINDOW_MS,
  buildTemplate,
  externalId,
  graphCall,
  inlineMime,
  isMetaMediaHost,
  nextStatus,
  parseWebhook,
  sameSecret,
  templateInfo,
  verifySignature,
  waRecipient,
  type FetchLike,
  type InboundMessage,
  type MetaChannel,
  type StatusUpdate,
  type TemplateInfo,
} from '../services/meta.js';
import { openSecret, sealSecret } from './mail-sync.js';
import { inboundGate } from '../services/inbound-gate.js';

/**
 * WhatsApp Business (Cloud API), Facebook Messenger and Instagram Direct in Konversationen.
 * Each sub-account stores its own Meta IDs and tokens (sealed). One webhook per sub-account
 * (/hooks/meta/<locationId>) takes all three: signature check, contact + conversation, status
 * updates. Sending respects the 24-hour window; outside it WhatsApp needs an approved template.
 * Tests swap the network via app.services.metaFetch.
 */

const MASK = '••••••';
const MEDIA_MAX = 25 * 1024 * 1024;
const TEMPLATE_TTL = 5 * 60_000;
const ID_FIELDS = ['wa_phone_number_id', 'wa_business_account_id'] as const;
const SECRET_FIELDS = ['wa_token', 'app_secret'] as const;
/** Fields of one Facebook page / Instagram account (a sub-account may connect several – table meta_pages). */
const PAGE_ID_FIELDS = ['page_id', 'ig_account_id'] as const;
const MAX_PAGES = 25;
/** Which column of meta_pages identifies the receiving account of a page channel. */
const PAGE_COLUMN = { messenger: 'page_id', instagram: 'ig_account_id' } as const;
type PageChannel = keyof typeof PAGE_COLUMN;

/**
 * The page part of the old single-record config moves into meta_pages (one row per page). Identities remember the page / Instagram
 * account a person wrote to (PSIDs and IGSIDs are scoped to it), so the reply goes out with that page's token. Exported for the test
 * of the migration.
 */
export const MIGRATE_META_PAGES = `
  UPDATE meta_identities SET account_id = COALESCE((SELECT CASE meta_identities.channel WHEN 'messenger' THEN a.page_id WHEN 'instagram' THEN a.ig_account_id ELSE '' END
    FROM meta_accounts a WHERE a.location_id = meta_identities.location_id), '') WHERE account_id = '';
  INSERT INTO meta_pages (id, location_id, page_id, page_name, page_token, ig_account_id, ig_username, created_at, updated_at)
    SELECT lower(hex(randomblob(10))), location_id, page_id, page_name, page_token, ig_account_id, ig_username, created_at, updated_at
    FROM meta_accounts WHERE page_id != '' OR ig_account_id != '' OR page_token != '';
  UPDATE meta_accounts SET page_id = '', page_name = '', page_token = '', ig_account_id = '', ig_username = '';
`;

interface Account {
  location_id: string;
  wa_phone_number_id: string;
  wa_business_account_id: string;
  wa_token: string;
  wa_display_phone: string;
  wa_verified_name: string;
  app_secret: string;
  verify_token: string;
  api_version: string;
  last_webhook_at: string | null;
  last_error: string | null;
}

/** One connected Facebook page and the Instagram account linked to it (both use the page's token). */
interface Page {
  id: string;
  location_id: string;
  page_id: string;
  page_name: string;
  page_token: string;
  ig_account_id: string;
  ig_username: string;
  created_at: string;
}

export interface MetaSendInput {
  contactId: string;
  channel: MetaChannel;
  body?: string;
  template?: { name: string; language?: string; values?: Record<string, string> };
  userId?: string;
  source?: string;
  ignoreDnd?: boolean;
  /** A message the default text payload cannot express (buttons, quick replies): builds the API body for the recipient id. `body` is what the inbox shows. */
  payload?: (to: string) => any;
}

const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 140);
const obj = (props: Record<string, any>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

const TOOLS = [
  {
    name: 'ghl_list_whatsapp_templates',
    title: 'WhatsApp-Vorlagen',
    description: 'Freigegebene WhatsApp-Vorlagen eines Projekts mit Text und Platzhaltern (slots, z. B. "body.1"). Außerhalb des 24-Stunden-Fensters lässt sich nur eine Vorlage senden.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: (call: any, a: any) => call.api('GET', '/api/messages/meta/templates', { location: a.location_id }),
  },
  {
    name: 'ghl_send_whatsapp',
    title: 'WhatsApp senden',
    description:
      'Sendet eine WhatsApp-Nachricht an einen Kontakt: freien Text (body, nur innerhalb von 24 h nach der letzten Nachricht des Kontakts) oder eine freigegebene Vorlage (template: {name, language, values: {"body.1": "Anna"}}). Verschickt echt; Messenger/Instagram gehen über ghl_send_message.',
    inputSchema: obj(
      {
        ...LOC,
        contact_id: { type: 'string' },
        body: { type: 'string', description: 'Freier Text (24-Stunden-Fenster)' },
        template: {
          type: 'object',
          properties: { name: { type: 'string' }, language: { type: 'string', description: 'z. B. de oder en_US' }, values: { type: 'object', description: 'Werte je slot aus ghl_list_whatsapp_templates' } },
          required: ['name'],
        },
      },
      ['location_id', 'contact_id'],
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call: any, a: any) => call.api('POST', '/api/messages/meta', { location: a.location_id, body: { contact_id: a.contact_id, channel: 'whatsapp', body: a.body, template: a.template } }),
  },
];

export const metaChannelsModule: Module = {
  name: 'meta-channels',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE meta_accounts (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        wa_phone_number_id TEXT NOT NULL DEFAULT '', wa_business_account_id TEXT NOT NULL DEFAULT '', wa_token TEXT NOT NULL DEFAULT '',
        wa_display_phone TEXT NOT NULL DEFAULT '', wa_verified_name TEXT NOT NULL DEFAULT '',
        page_id TEXT NOT NULL DEFAULT '', page_token TEXT NOT NULL DEFAULT '', page_name TEXT NOT NULL DEFAULT '',
        ig_account_id TEXT NOT NULL DEFAULT '', ig_username TEXT NOT NULL DEFAULT '',
        app_secret TEXT NOT NULL DEFAULT '', verify_token TEXT NOT NULL, api_version TEXT NOT NULL DEFAULT '${DEFAULT_GRAPH_VERSION}',
        last_webhook_at TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX meta_accounts_wa ON meta_accounts(wa_phone_number_id);
      CREATE INDEX meta_accounts_page ON meta_accounts(page_id);
      CREATE INDEX meta_accounts_ig ON meta_accounts(ig_account_id);
      CREATE TABLE meta_identities (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, channel TEXT NOT NULL, external_id TEXT NOT NULL,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, channel, external_id)
      );
      CREATE INDEX meta_identities_contact ON meta_identities(contact_id, channel);
      ALTER TABLE messages ADD COLUMN meta_media TEXT;
      `,
    ],
    [
      // Several Facebook pages / Instagram accounts per sub-account: the single page of meta_accounts becomes a list.
      '002-pages',
      `
      CREATE TABLE meta_pages (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        page_id TEXT NOT NULL DEFAULT '', page_name TEXT NOT NULL DEFAULT '', page_token TEXT NOT NULL DEFAULT '',
        ig_account_id TEXT NOT NULL DEFAULT '', ig_username TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX meta_pages_loc ON meta_pages(location_id, created_at);
      CREATE INDEX meta_pages_page ON meta_pages(page_id);
      CREATE INDEX meta_pages_ig ON meta_pages(ig_account_id);
      ALTER TABLE meta_identities ADD COLUMN account_id TEXT NOT NULL DEFAULT '';
      ${MIGRATE_META_PAGES}
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const fetcher = (): FetchLike => app.services.metaFetch ?? ((u: string, i?: RequestInit) => fetch(u, i));

    // --- accounts ---------------------------------------------------------------------
    const account = (locationId: string) => db.get<Account>('SELECT * FROM meta_accounts WHERE location_id = ?', locationId);
    const ensureAccount = (locationId: string): Account => {
      const a = account(locationId);
      if (a) return a;
      db.insert('meta_accounts', { location_id: locationId, verify_token: token(18), api_version: DEFAULT_GRAPH_VERSION, created_at: now(), updated_at: now() });
      return account(locationId)!;
    };
    const open = (sealed: string) => {
      if (!sealed) return '';
      try {
        return openSecret(app, sealed);
      } catch {
        return ''; // the server secret changed: the token has to be entered again
      }
    };
    // --- pages (Facebook page + linked Instagram account, each with the page's token) ---------------------------
    const pagesOf = (locationId: string) => db.all<Page>('SELECT * FROM meta_pages WHERE location_id = ? ORDER BY created_at, rowid', locationId);
    const pageOk = (p: Page | undefined, ch: PageChannel): p is Page => !!p && !!p.page_token && !!p[PAGE_COLUMN[ch]];
    /** The page a channel uses when nothing says otherwise: the first one that can serve it. */
    const primary = (locationId: string, ch: PageChannel) => pagesOf(locationId).find((p) => pageOk(p, ch));
    const pageByAccount = (locationId: string, ch: PageChannel, accountId: string) =>
      accountId ? db.get<Page>(`SELECT * FROM meta_pages WHERE location_id = ? AND ${PAGE_COLUMN[ch]} = ?`, locationId, accountId) : undefined;
    const pageLabel = (p: Page, ch: PageChannel) => (ch === 'instagram' ? (p.ig_username ? `@${p.ig_username}` : p.ig_account_id) : p.page_name || p.page_id);
    const pageOut = (p: Page) => ({ id: p.id, page_id: p.page_id, page_name: p.page_name, token_set: !!p.page_token, ig_account_id: p.ig_account_id, ig_username: p.ig_username, messenger: pageOk(p, 'messenger'), instagram: pageOk(p, 'instagram') });

    const tokenFor = (a: Account, ch: MetaChannel, page?: Page) => (ch === 'whatsapp' ? open(a.wa_token) : open((page ?? primary(a.location_id, ch))?.page_token ?? ''));
    const configured = (a: Account | undefined, ch: MetaChannel) => !!a && (ch === 'whatsapp' ? !!(a.wa_phone_number_id && a.wa_token) : !!primary(a.location_id, ch));
    /** A Graph call with the token of the channel – for Messenger/Instagram the given page's (else the primary page's). */
    const graph = <T = any>(a: Account, ch: MetaChannel, method: string, path: string, body?: unknown, timeoutMs?: number, page?: Page) =>
      graphCall<T>(fetcher(), a.api_version || DEFAULT_GRAPH_VERSION, tokenFor(a, ch, page), method, path, body, timeoutMs);
    /** Graph errors become a readable 502 for the settings screen. */
    const relay = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof MetaApiError) throw new HttpError(502, e.message);
        throw e;
      }
    };
    const noteError = (locationId: string, msg: string | null) => db.run('UPDATE meta_accounts SET last_error = ? WHERE location_id = ?', msg ? msg.slice(0, 500) : null, locationId);

    const out = (a: Account) => ({
      webhook_url: `${app.baseUrl()}/hooks/meta/${a.location_id}`,
      verify_token: a.verify_token,
      app_secret_set: !!a.app_secret,
      api_version: a.api_version || DEFAULT_GRAPH_VERSION,
      whatsapp: {
        phone_number_id: a.wa_phone_number_id,
        business_account_id: a.wa_business_account_id,
        token_set: !!a.wa_token,
        display_phone: a.wa_display_phone,
        verified_name: a.wa_verified_name,
        configured: configured(a, 'whatsapp'),
      },
      // The first page that serves each channel (the single-page shape of earlier versions); `pages` is the full list.
      messenger: { page_id: primary(a.location_id, 'messenger')?.page_id ?? '', page_name: primary(a.location_id, 'messenger')?.page_name ?? '', token_set: !!primary(a.location_id, 'messenger'), configured: configured(a, 'messenger') },
      instagram: { account_id: primary(a.location_id, 'instagram')?.ig_account_id ?? '', username: primary(a.location_id, 'instagram')?.ig_username ?? '', configured: configured(a, 'instagram') },
      pages: pagesOf(a.location_id).map(pageOut),
      last_webhook_at: a.last_webhook_at,
      last_error: a.last_error,
    });

    // --- contacts and identities (wa_id / PSID / IGSID → contact) -------------------------
    const identity = (locationId: string, ch: MetaChannel, ext: string) =>
      db.get('SELECT * FROM meta_identities WHERE location_id = ? AND channel = ? AND external_id = ?', locationId, ch, ext);
    const identityOfContact = (locationId: string, contactId: string, ch: MetaChannel) =>
      db.get('SELECT * FROM meta_identities WHERE location_id = ? AND contact_id = ? AND channel = ? ORDER BY created_at DESC LIMIT 1', locationId, contactId, ch);
    const link = (locationId: string, ch: MetaChannel, ext: string, contactId: string, name: string, accountId = '') =>
      db.run('INSERT OR IGNORE INTO meta_identities (location_id, channel, external_id, contact_id, name, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?)', locationId, ch, ext, contactId, name.slice(0, 120), now(), accountId);

    const lookupProfile = async (a: Account, page: Page | undefined, ch: MetaChannel, psid: string): Promise<{ name?: string; username?: string }> => {
      if (!page?.page_token) return {};
      try {
        const r = await graph<any>(a, 'messenger', 'GET', `${psid}?fields=${ch === 'instagram' ? 'name,username' : 'first_name,last_name'}`, undefined, 5000, page);
        const name = ch === 'instagram' ? r?.name : [r?.first_name, r?.last_name].filter(Boolean).join(' ');
        return { name: name ? String(name).slice(0, 120) : undefined, username: r?.username ? String(r.username).replace(/[^\w.]/g, '').slice(0, 60) : undefined };
      } catch {
        return {}; // without the profile permission Meta refuses – the contact gets a neutral name
      }
    };

    const contactFor = async (a: Account, page: Page | undefined, e: InboundMessage): Promise<Contact> => {
      const loc = a.location_id;
      const known = identity(loc, e.channel, e.from);
      const linked = known ? getContact(app, loc, known.contact_id) : undefined;
      if (linked) return linked;
      if (e.channel === 'whatsapp') {
        // Same E.164 form the contacts module uses, so an existing contact with this number is reused.
        const phone = normalizePhone(`+${e.from}`);
        let c = parseJson(db.get<Contact>('SELECT * FROM contacts WHERE location_id = ? AND phone = ?', loc, phone), ['tags', 'custom']);
        if (!c) c = upsertContact(app, loc, { phone, name: e.name || undefined }, { source: 'WhatsApp', tags: ['whatsapp'] }).contact;
        link(loc, 'whatsapp', e.from, c.id, e.name ?? '', e.account);
        return c;
      }
      const profile = await lookupProfile(a, page, e.channel, e.from);
      const again = identity(loc, e.channel, e.from); // a retried delivery may have linked it meanwhile
      const c2 = again ? getContact(app, loc, again.contact_id) : undefined;
      if (c2) return c2;
      const label = CHANNEL_LABEL[e.channel];
      const name = profile.name || (profile.username ? `@${profile.username}` : `${label}-Kontakt`);
      const c = upsertContact(app, loc, { name, ...(profile.username ? { custom: { instagram: `@${profile.username}` } } : {}) }, { source: label, tags: [e.channel] }).contact;
      link(loc, e.channel, e.from, c.id, profile.username ? `@${profile.username}` : name, e.account);
      return c;
    };

    // --- inbound ---------------------------------------------------------------------
    const receive = async (a: Account, page: Page | undefined, e: InboundMessage): Promise<boolean> => {
      const loc = a.location_id;
      if (!/^\d{3,40}$/.test(e.from)) return false;
      if (db.get('SELECT id FROM messages WHERE location_id = ? AND external_id = ?', loc, e.externalId)) return false;
      const contact = await contactFor(a, page, e);
      // With several pages the inbox shows which one the message came in on ("Messenger · Seite B") – a sub-channel.
      const viaPage = page && e.channel !== 'whatsapp' && pagesOf(loc).length > 1 ? ` · ${pageLabel(page, e.channel)}` : '';
      const conversationId = getOrCreateConversation(app, loc, contact.id);
      // Meta's timestamps have whole seconds: live messages keep our clock (so a quick reply never
      // sorts above the message it answers); late deliveries keep Meta's time.
      const at = Date.now() - new Date(e.at).getTime() > 120_000 ? e.at : now();
      const msg = {
        id: id(),
        location_id: loc,
        conversation_id: conversationId,
        contact_id: contact.id,
        channel: e.channel,
        direction: 'in',
        subject: '',
        body: e.body,
        status: 'received',
        error: '',
        source: `${CHANNEL_LABEL[e.channel]}${viaPage}`,
        external_id: e.externalId,
        meta_media: e.attachment ?? null,
        created_at: at,
      };
      try {
        db.insert('messages', msg);
      } catch (err) {
        if (/UNIQUE/i.test((err as Error).message)) return false; // the same delivery, twice at once
        throw err;
      }
      // A late delivery (older than the thread's newest message) only counts as unread.
      const newer = db.get('SELECT 1 FROM messages WHERE conversation_id = ? AND created_at > ? AND id != ? LIMIT 1', conversationId, msg.created_at, msg.id);
      if (newer) db.run('UPDATE conversations SET unread = unread + 1 WHERE id = ?', conversationId);
      else db.run('UPDATE conversations SET unread = unread + 1, last_message = ?, last_message_at = ? WHERE id = ?', preview(e.body), msg.created_at, conversationId);
      if (/^\s*(stop|stopp|abmelden)\s*$/i.test(e.body)) db.run('UPDATE contacts SET dnd = 1 WHERE id = ?', contact.id);
      // Receive hook (services/inbound-gate.ts): a blocked sender's message is archived silently – no event, no workflow.
      const claim = inboundGate(app, { locationId: loc, contactId: contact.id, channel: e.channel });
      if (claim) return (claim.archive(conversationId, msg.id), true);
      logActivity(app, loc, contact.id, `${e.channel}.received`, `${CHANNEL_LABEL[e.channel]}-Nachricht empfangen`);
      app.events.emit(loc, 'message.inbound', { contactId: contact.id, contact: getContact(app, loc, contact.id), message: msg });
      return true;
    };

    const markUpTo = (loc: string, contactId: string, ch: MetaChannel, until: string, status: 'delivered' | 'read') =>
      db.run(
        `UPDATE messages SET status = ? WHERE location_id = ? AND contact_id = ? AND channel = ? AND direction = 'out' AND created_at <= ? AND status IN (${status === 'read' ? `'sent','delivered'` : `'sent'`})`,
        status,
        loc,
        contactId,
        ch,
        until,
      ).changes;

    const applyStatus = (a: Account, e: StatusUpdate): number => {
      const loc = a.location_id;
      if (e.externalId) {
        const m = db.get(`SELECT id, status, contact_id, created_at FROM messages WHERE location_id = ? AND external_id = ? AND direction = 'out'`, loc, e.externalId);
        if (!m) return 0;
        let n = 0;
        const next = nextStatus(m.status, e.status);
        if (next === 'failed') {
          db.run(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`, e.error || 'Zustellung fehlgeschlagen', m.id);
          logActivity(app, loc, m.contact_id, `${e.channel}.failed`, `${CHANNEL_LABEL[e.channel]}-Nachricht nicht zugestellt${e.error ? `: ${e.error}` : ''}`);
          n++;
        } else if (next) n += db.run('UPDATE messages SET status = ? WHERE id = ?', next, m.id).changes;
        // Instagram reports the last read message: everything before it is read as well.
        if (e.status === 'read' && e.channel !== 'whatsapp') n += markUpTo(loc, m.contact_id, e.channel, m.created_at, 'read');
        return n;
      }
      if (e.watermark && e.party) {
        const who = identity(loc, e.channel, e.party);
        return who && (e.status === 'read' || e.status === 'delivered') ? markUpTo(loc, who.contact_id, e.channel, e.watermark, e.status) : 0;
      }
      return 0;
    };

    /** Which sub-account an event belongs to. Accounts sharing one Meta app (same app secret) may share a webhook URL. */
    /**
     * Which sub-account (and which of its pages) an event belongs to – by phone number ID, page ID or Instagram account ID. Accounts
     * sharing one Meta app (same app secret) may share a webhook URL.
     */
    const route = (hook: Account, appSecret: string, e: { channel: MetaChannel; account: string }): { account: Account; page?: Page } | undefined => {
      if (!e.account) return undefined;
      if (e.channel === 'whatsapp') {
        if (hook.wa_phone_number_id === e.account) return { account: hook };
        for (const other of db.all<Account>('SELECT * FROM meta_accounts WHERE wa_phone_number_id = ?', e.account)) if (sameSecret(open(other.app_secret), appSecret)) return { account: other };
        return undefined;
      }
      const rows = db.all<Page>(`SELECT * FROM meta_pages WHERE ${PAGE_COLUMN[e.channel]} = ?`, e.account);
      const own = rows.find((p) => p.location_id === hook.location_id);
      if (own) return { account: hook, page: own };
      for (const p of rows) {
        const other = account(p.location_id);
        if (other && sameSecret(open(other.app_secret), appSecret)) return { account: other, page: p };
      }
      return undefined;
    };

    // Meta checks the address once ("Verify and save"): echo the challenge if the token matches.
    router.get('/hooks/meta/:loc', 'public', (ctx) => {
      const a = account(ctx.params.loc);
      const challenge = ctx.query.get('hub.challenge') ?? '';
      if (!a || ctx.query.get('hub.mode') !== 'subscribe' || !sameSecret(ctx.query.get('hub.verify_token') ?? '', a.verify_token)) throw new HttpError(403, 'Verify-Token stimmt nicht');
      if (!/^[\w.-]{1,200}$/.test(challenge)) throw bad('hub.challenge fehlt');
      return text(challenge);
    });

    router.post('/hooks/meta/:loc', 'public', async (ctx) => {
      const hook = account(ctx.params.loc);
      if (!hook) throw notFound();
      const appSecret = open(hook.app_secret);
      if (!appSecret) throw new HttpError(403, 'App-Secret fehlt (Einstellungen → Kanäle)');
      // HMAC over the exact bytes Meta sent (the core keeps the body as UTF-8 text, which round-trips for JSON).
      if (!verifySignature(ctx.rawBody, ctx.req.headers['x-hub-signature-256'], appSecret)) throw new HttpError(401, 'Signatur ungültig');
      db.run('UPDATE meta_accounts SET last_webhook_at = ? WHERE location_id = ?', now(), hook.location_id);
      // Other modules share this callback address (a Meta app has one per object), e.g. Lead Ads (modules/ads-leads.ts).
      for (const h of (app.services.metaWebhookHooks ?? []) as ((e: { payload: any; secret: string; locationId: string }) => Promise<void> | void)[]) {
        try {
          await h({ payload: ctx.body, secret: appSecret, locationId: hook.location_id });
        } catch (err) {
          console.error('[meta] webhook hook failed', err);
        }
      }
      const result = { messages: 0, statuses: 0, skipped: 0 };
      for (const e of parseWebhook(ctx.body)) {
        const target = route(hook, appSecret, e);
        if (!target) {
          result.skipped++;
          if (e.kind === 'message') noteError(hook.location_id, `${CHANNEL_LABEL[e.channel]}-Nachricht an unbekannte ID ${String(e.account).slice(0, 40) || '–'} ignoriert – bitte unter Einstellungen → Kanäle prüfen`);
          continue;
        }
        try {
          if (e.kind === 'message') result.messages += (await receive(target.account, target.page, e)) ? 1 : 0;
          else result.statuses += applyStatus(target.account, e);
        } catch (err) {
          // Answer 200 anyway: Meta would retry the whole batch and eventually switch the webhook off.
          console.error('[meta] webhook event failed', err);
          noteError(target.account.location_id, `Eingang fehlgeschlagen: ${(err as Error).message}`);
        }
      }
      return { ok: true, ...result };
    });

    // --- window, templates, sending ------------------------------------------------------
    const windowState = (loc: string, contactId: string, ch: MetaChannel) => {
      const at = db.get<{ at: string | null }>(`SELECT MAX(created_at) AS at FROM messages WHERE location_id = ? AND contact_id = ? AND channel = ? AND direction = 'in'`, loc, contactId, ch)?.at ?? null;
      const ends = at ? new Date(at).getTime() + WINDOW_MS : 0;
      return { open: ends > Date.now(), last_inbound_at: at, ends_at: ends ? new Date(ends).toISOString() : null };
    };

    const tplCache = new Map<string, { at: number; list: TemplateInfo[] }>();
    const templates = async (loc: string, fresh = false): Promise<TemplateInfo[]> => {
      const a = account(loc);
      if (!configured(a, 'whatsapp')) throw bad('WhatsApp ist nicht eingerichtet (Einstellungen → Kanäle)');
      if (!a!.wa_business_account_id) throw bad('WhatsApp-Business-Konto-ID fehlt (Einstellungen → Kanäle)');
      const hit = tplCache.get(loc);
      if (!fresh && hit && Date.now() - hit.at < TEMPLATE_TTL) return hit.list;
      const r = await relay(() => graph<any>(a!, 'whatsapp', 'GET', `${a!.wa_business_account_id}/message_templates?fields=name,language,status,category,components&limit=250`));
      const list = (Array.isArray(r?.data) ? r.data : [])
        .filter((t: any) => String(t.status).toUpperCase() === 'APPROVED')
        .map(templateInfo)
        .sort((x: TemplateInfo, y: TemplateInfo) => x.name.localeCompare(y.name) || x.language.localeCompare(y.language));
      tplCache.set(loc, { at: Date.now(), list });
      return list;
    };
    // The approved templates of a sub-account for modules that send them in bulk (WhatsApp campaigns): (locationId, fresh?) => TemplateInfo[].
    app.services.metaTemplates = templates;

    /** Whom to send to – and, for Messenger/Instagram, through which page: the one the person wrote to (their PSID/IGSID belongs to it). */
    const recipient = (loc: string, c: Contact, ch: MetaChannel): { to: string; page?: Page; reason?: string } => {
      const ident = identityOfContact(loc, c.id, ch);
      if (ch === 'whatsapp') {
        const to = ident?.external_id || waRecipient(c.phone);
        return to ? { to } : { to: '', reason: 'Kontakt hat keine gültige Telefonnummer' };
      }
      if (!ident) return { to: '', reason: `Kontakt hat noch nicht über ${CHANNEL_LABEL[ch]} geschrieben` };
      // Identities from before several pages existed carry no account: they belong to the (then only) primary page.
      const page = ident.account_id ? pageByAccount(loc, ch, ident.account_id) : primary(loc, ch);
      if (!pageOk(page, ch)) return { to: '', reason: ch === 'instagram' ? 'Das Instagram-Konto, an das der Kontakt geschrieben hat, ist nicht mehr verbunden' : 'Die Seite, an die der Kontakt geschrieben hat, ist nicht mehr verbunden' };
      return { to: ident.external_id, page };
    };

    const sendMeta = async (loc: string, input: MetaSendInput) => {
      const ch = input.channel;
      if (!META_CHANNELS.includes(ch)) throw bad('Unbekannter Kanal');
      const label = CHANNEL_LABEL[ch];
      const a = account(loc);
      if (!a || !configured(a, ch)) throw bad(`${label} ist nicht eingerichtet (Einstellungen → Kanäle)`);
      const c = getContact(app, loc, input.contactId);
      if (!c) throw notFound('Kontakt nicht gefunden');
      const { to, reason, page } = recipient(loc, c, ch);
      if (!to) throw bad(reason!);
      const win = windowState(loc, c.id, ch);

      let payload: any;
      let body: string;
      let subject = '';
      // A business-started template of category MARKETING is advertising (consent gate, modules/consent.ts); replies inside the window are not.
      let marketing = false;
      if (input.template) {
        if (ch !== 'whatsapp') throw bad('Vorlagen gibt es nur bei WhatsApp');
        const name = str(input.template.name, 'Vorlage', { required: true, max: 512 });
        const lang = str(input.template.language, 'Sprache', { max: 20 });
        const pick = (list: TemplateInfo[]) => list.find((t) => t.name === name && (!lang || t.language === lang));
        const t = pick(await templates(loc)) ?? pick(await templates(loc, true));
        if (!t) throw bad(`Vorlage „${name}“${lang ? ` (${lang})` : ''} nicht gefunden oder nicht freigegeben`);
        if (!t.supported) throw bad(`Vorlage „${name}“: ${t.reason}`);
        let built: ReturnType<typeof buildTemplate>;
        try {
          built = buildTemplate(t, input.template.values && typeof input.template.values === 'object' ? input.template.values : {});
        } catch (e) {
          throw bad((e as Error).message);
        }
        payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: t.name, language: { code: t.language }, ...(built.components.length ? { components: built.components } : {}) } };
        body = built.text;
        subject = `Vorlage: ${t.name}`;
        marketing = String(t.category).toUpperCase() === 'MARKETING';
      } else {
        body = String(input.body ?? '').trim();
        if (!body) throw bad('Nachricht fehlt');
        if (body.length > TEXT_LIMITS[ch]) throw bad(`Zu lang für ${label}: ${body.length} von max. ${TEXT_LIMITS[ch]} Zeichen`);
        if (!win.open) {
          throw bad(
            ch === 'whatsapp'
              ? 'Das 24-Stunden-Fenster ist geschlossen – bitte eine freigegebene Vorlage senden'
              : `Das 24-Stunden-Fenster ist geschlossen – über ${label} geht es erst weiter, wenn der Kontakt wieder schreibt`,
          );
        }
        payload =
          input.payload?.(to) ??
          (ch === 'whatsapp'
            ? { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: /https?:\/\//.test(body), body } }
            : { recipient: { id: to }, messaging_type: 'RESPONSE', message: { text: body } });
      }

      const conversationId = getOrCreateConversation(app, loc, c.id);
      const msg = { id: id(), location_id: loc, conversation_id: conversationId, contact_id: c.id, channel: ch, direction: 'out', subject, body, status: 'queued', error: '', source: input.source ?? 'manuell', user_id: input.userId ?? null, created_at: now() };
      db.insert('messages', msg);
      db.run('UPDATE conversations SET last_message_at = ?, last_message = ? WHERE id = ?', msg.created_at, preview(body), conversationId);
      const fail = (error: string) => {
        db.run(`UPDATE messages SET status = 'failed', error = ? WHERE id = ?`, error, msg.id);
        return { ...msg, status: 'failed', error };
      };
      if (c.dnd && !input.ignoreDnd) return fail('Kontakt hat „Nicht stören“ aktiv');
      // „Nicht stören“ for this one channel (workflow step "DND je Kanal") counts like for e-mail and SMS.
      const channelDnd: string | undefined = input.ignoreDnd ? undefined : app.services.channelDnd?.(loc, c.id, ch);
      if (channelDnd) return fail(channelDnd);
      const consent: { blocked?: string } | undefined = app.services.consentGate?.({ locationId: loc, contact: c, channel: ch, purpose: marketing ? 'marketing' : undefined, bulk: false, ignoreDnd: !!input.ignoreDnd, messageId: msg.id, source: input.source });
      if (consent?.blocked) return fail(consent.blocked);
      try {
        const r = await graph<any>(a, ch, 'POST', ch === 'whatsapp' ? `${a.wa_phone_number_id}/messages` : 'me/messages', payload, undefined, page);
        const providerId = String((ch === 'whatsapp' ? r?.messages?.[0]?.id : r?.message_id) ?? '') || null;
        // A status webhook may already have moved it on; only a queued message becomes "sent".
        db.run(`UPDATE messages SET status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END, provider_id = ?, external_id = ? WHERE id = ?`, providerId, providerId ? externalId(ch, providerId) : null, msg.id);
        logActivity(app, loc, c.id, `${ch}.sent`, `${label}-Nachricht gesendet${subject ? ` (${subject})` : ''}`);
        return { ...msg, status: 'sent', provider_id: providerId };
      } catch (e) {
        return fail((e as Error).message);
      }
    };
    app.services.metaSend = sendMeta;
    // For modules that build on the Meta setup (comment-to-DM): which sub-account owns an account id (accounts sharing one Meta app secret
    // share a webhook), the sub-account's account ids (never tokens), Graph calls with its token, and the 24-hour window state.
    app.services.metaKit = {
      accountFor: (hookLocationId: string, secret: string, channel: MetaChannel, accountId: string): string | undefined => {
        const hook = account(hookLocationId);
        return hook ? route(hook, secret, { channel, account: accountId })?.account.location_id : undefined;
      },
      /** The primary page's ids (the single-page shape) plus every connected page. */
      ids: (loc: string) => {
        const a = account(loc);
        if (!a) return undefined;
        const m = primary(loc, 'messenger');
        const i = primary(loc, 'instagram');
        return {
          page_id: m?.page_id ?? '',
          page_name: m?.page_name ?? '',
          ig_account_id: i?.ig_account_id ?? '',
          ig_username: i?.ig_username ?? '',
          messenger: configured(a, 'messenger'),
          instagram: configured(a, 'instagram'),
          whatsapp: configured(a, 'whatsapp'),
          pages: pagesOf(loc).map((p) => ({ page_id: p.page_id, page_name: p.page_name, ig_account_id: p.ig_account_id, ig_username: p.ig_username, messenger: pageOk(p, 'messenger'), instagram: pageOk(p, 'instagram') })),
        };
      },
      /** A Graph call with the sub-account's token; `accountId` (page ID or Instagram account ID) picks the page, else the primary one. */
      graph: (loc: string, channel: MetaChannel, method: string, path: string, body?: unknown, accountId?: string) => {
        const a = account(loc);
        if (!a || !configured(a, channel)) throw bad(`${CHANNEL_LABEL[channel]} ist nicht eingerichtet (Einstellungen → Kanäle)`);
        let page: Page | undefined;
        if (channel !== 'whatsapp' && accountId) {
          page = pageByAccount(loc, channel, accountId) ?? pageByAccount(loc, channel === 'instagram' ? 'messenger' : 'instagram', accountId);
          if (!pageOk(page, channel)) throw bad(`${CHANNEL_LABEL[channel]}: Konto ${accountId.slice(0, 40)} ist nicht verbunden (Einstellungen → Kanäle)`);
        }
        return relay(() => graph<any>(a, channel, method, path, body, undefined, page));
      },
      windowState,
    };

    const sendFromRequest = (ctx: Ctx, channel: MetaChannel) =>
      sendMeta(ctx.locationId, {
        contactId: str(ctx.body.contact_id, 'Kontakt', { required: true }),
        channel,
        body: ctx.body.body === undefined ? undefined : str(ctx.body.body, 'Nachricht', { max: 10_000 }),
        template: ctx.body.template && typeof ctx.body.template === 'object' ? ctx.body.template : undefined,
        userId: ctx.user?.id,
        ignoreDnd: !!ctx.body.ignoreDnd,
      });
    // POST /api/messages with channel whatsapp|messenger|instagram lands here (REST API, MCP ghl_send_message).
    app.services.messageChannels = {
      ...(app.services.messageChannels ?? {}),
      ...Object.fromEntries(META_CHANNELS.map((ch) => [ch, (ctx: Ctx) => sendFromRequest(ctx, ch)])),
    };

    router.post('/api/messages/meta', 'location', (ctx) => {
      if (!META_CHANNELS.includes(ctx.body.channel)) throw bad('Kanal: whatsapp, messenger oder instagram');
      return sendFromRequest(ctx, ctx.body.channel);
    });

    /** What the composer may offer for this contact: configured channels, recipient, 24-hour window. */
    router.get('/api/messages/meta/status', 'location', (ctx) => {
      const c = getContact(app, ctx.locationId, str(ctx.query.get('contact_id'), 'Kontakt', { required: true }));
      if (!c) throw notFound('Kontakt nicht gefunden');
      const a = account(ctx.locationId);
      const channels: Record<string, any> = {};
      for (const ch of META_CHANNELS) {
        if (!configured(a, ch)) {
          channels[ch] = { configured: false };
          continue;
        }
        const { to, reason, page } = recipient(ctx.locationId, c, ch);
        // `via`: the page / Instagram account the reply goes out from (shown in the composer when several are connected).
        const via = page && ch !== 'whatsapp' && pagesOf(ctx.locationId).length > 1 ? pageLabel(page, ch) : undefined;
        channels[ch] = { configured: true, reachable: !!to, reason, via, window: windowState(ctx.locationId, c.id, ch), templates: ch === 'whatsapp' && !!a!.wa_business_account_id, limit: TEXT_LIMITS[ch] };
      }
      return { channels };
    });

    router.get('/api/messages/meta/templates', 'location', (ctx) => templates(ctx.locationId, ctx.query.get('refresh') === '1'));

    /** Media of an inbound message, fetched from Meta when someone looks at it (WhatsApp keeps it 30 days). */
    router.get('/api/messages/meta/media/:id', 'location', async (ctx): Promise<RawResult> => {
      const m = db.get('SELECT * FROM messages WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      const att = m?.meta_media ? JSON.parse(m.meta_media) : null;
      if (!att || (!att.media_id && !att.url)) throw notFound();
      let url: string = att.url ?? '';
      let mime: string = att.mime ?? '';
      const headers: Record<string, string> = {};
      if (att.media_id) {
        const a = account(ctx.locationId);
        if (!a || !configured(a, 'whatsapp')) throw new HttpError(409, 'WhatsApp ist nicht mehr verbunden');
        if (!/^\d{1,40}$/.test(String(att.media_id))) throw bad('Ungültige Medien-ID');
        const info = await relay(() => graph<any>(a, 'whatsapp', 'GET', String(att.media_id)));
        url = String(info?.url ?? '');
        mime = String(info?.mime_type ?? mime);
        headers.authorization = `Bearer ${tokenFor(a, 'whatsapp')}`;
      }
      // Only Meta's own media hosts are fetched, redirects included; the token never leaves the first host.
      let r: Response | undefined;
      const firstHost = isMetaMediaHost(url) ? new URL(url).host : '';
      for (let hop = 0; hop < 4; hop++) {
        if (!isMetaMediaHost(url)) throw bad('Unerwartete Medien-Adresse');
        try {
          r = await fetcher()(url, { headers: new URL(url).host === firstHost ? headers : {}, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
        } catch (e) {
          throw new HttpError(502, `Datei nicht abrufbar: ${(e as Error).message}`);
        }
        const next = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
        if (!next) break;
        url = new URL(next, url).toString();
        r = undefined;
      }
      if (!r) throw new HttpError(502, 'Datei nicht abrufbar (zu viele Weiterleitungen)');
      if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, r.status === 404 ? 'Datei bei Meta nicht mehr verfügbar' : `Datei nicht abrufbar (${r.status})`);
      if (Number(r.headers.get('content-length') || 0) > MEDIA_MAX) throw new HttpError(413, 'Datei zu groß für die Vorschau');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MEDIA_MAX) throw new HttpError(413, 'Datei zu groß für die Vorschau');
      const type = (mime || r.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const inline = inlineMime(type);
      const filename = String(att.filename || att.kind || 'datei').replace(/[^\w.\- ]+/g, '_').slice(0, 100);
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': inline ? type : 'application/octet-stream', 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`, 'cache-control': 'private, max-age=3600' },
        body: buf,
      };
    });

    // --- settings (Einstellungen → Kanäle) ---------------------------------------------------
    router.get('/api/settings/meta', 'location', (ctx) => out(ensureAccount(ctx.locationId)));

    const ID_LABEL: Record<string, string> = { wa_phone_number_id: 'Telefonnummer-ID', wa_business_account_id: 'WhatsApp-Business-Konto-ID', page_id: 'Seiten-ID', ig_account_id: 'Instagram-Konto-ID' };
    const cleanId = (b: any, f: string) => {
      const v = str(b[f], f, { max: 40 }).replace(/\s+/g, '');
      if (v && !/^\d{3,40}$/.test(v)) throw bad(`${ID_LABEL[f]}: nur Ziffern`);
      return v;
    };
    const cleanSecret = (b: any, f: string): string | undefined => {
      if (b[f] === null) return '';
      if (b[f] === undefined || b[f] === '' || b[f] === MASK) return undefined;
      const v = str(b[f], f, { max: 1000 });
      if (!/^[\w|.-]{16,1000}$/.test(v)) throw bad(`${f === 'app_secret' ? 'App-Secret' : 'Zugriffstoken'} sieht ungültig aus`);
      return sealSecret(app, v);
    };
    /** The page fields of a request (page_id, ig_account_id, page_token) as a patch of one meta_pages row. */
    const pagePatch = (loc: string, b: any, cur?: Page): Record<string, string> => {
      const patch: Record<string, string> = {};
      for (const f of PAGE_ID_FIELDS) if (b[f] !== undefined) patch[f] = cleanId(b, f);
      const tok = cleanSecret(b, 'page_token');
      if (tok !== undefined) patch.page_token = tok;
      // A page or Instagram account belongs to one entry of the list.
      for (const f of PAGE_ID_FIELDS) {
        if (!patch[f] || patch[f] === cur?.[f]) continue;
        if (db.get(`SELECT 1 FROM meta_pages WHERE location_id = ? AND ${f} = ? AND id != ?`, loc, patch[f], cur?.id ?? '')) throw bad(`${ID_LABEL[f]} ${patch[f]} ist schon verbunden`);
      }
      // Names read from Meta belong to the old IDs.
      if (patch.page_id !== undefined && patch.page_id !== cur?.page_id) patch.page_name = '';
      if (patch.ig_account_id !== undefined && patch.ig_account_id !== cur?.ig_account_id) patch.ig_username = '';
      return patch;
    };
    const writePage = (loc: string, patch: Record<string, string>, cur?: Page): Page => {
      if (cur) {
        const keys = Object.keys(patch);
        if (keys.length) db.run(`UPDATE meta_pages SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k]), now(), cur.id);
        return db.get<Page>('SELECT * FROM meta_pages WHERE id = ?', cur.id)!;
      }
      if (db.get<{ n: number }>('SELECT COUNT(*) n FROM meta_pages WHERE location_id = ?', loc)!.n >= MAX_PAGES) throw bad(`Höchstens ${MAX_PAGES} Seiten je Sub-Account`);
      const row = { id: id(), location_id: loc, page_id: '', page_name: '', page_token: '', ig_account_id: '', ig_username: '', ...patch, created_at: now(), updated_at: now() };
      db.insert('meta_pages', row);
      return row as Page;
    };

    router.put('/api/settings/meta', 'location', (ctx) => {
      const cur = ensureAccount(ctx.locationId);
      const b = ctx.body ?? {};
      const patch: Record<string, any> = {};
      for (const f of ID_FIELDS) if (b[f] !== undefined) patch[f] = cleanId(b, f);
      for (const f of SECRET_FIELDS) {
        const v = cleanSecret(b, f);
        if (v !== undefined) patch[f] = v;
      }
      if (b.regenerate_verify_token) patch.verify_token = token(18);
      else if (b.verify_token !== undefined && b.verify_token !== cur.verify_token) {
        const v = str(b.verify_token, 'Verify-Token', { max: 100 });
        if (!/^[\w.~-]{8,100}$/.test(v)) throw bad('Verify-Token: 8–100 Zeichen, nur Buchstaben, Ziffern und - _ . ~');
        patch.verify_token = v;
      }
      if (b.api_version !== undefined) {
        const v = str(b.api_version, 'API-Version', { max: 10 }) || DEFAULT_GRAPH_VERSION;
        if (!/^v\d{2}\.\d$/.test(v) || Number(v.slice(1)) < 21) throw bad('API-Version wie v21.0 (mindestens v21.0)');
        patch.api_version = v;
      }
      // The single-page fields of earlier versions edit the first page of the list (or create it).
      const first = pagesOf(ctx.locationId)[0];
      const pp = pagePatch(ctx.locationId, b, first);
      if (Object.keys(pp).length && (first || Object.values(pp).some(Boolean))) {
        const p = writePage(ctx.locationId, pp, first);
        // "Messenger & Instagram trennen" (all fields emptied) removes that page from the list.
        if (!p.page_id && !p.ig_account_id && !p.page_token) db.run('DELETE FROM meta_pages WHERE id = ?', p.id);
      }
      // Names read from Meta belong to the old IDs.
      if (patch.wa_phone_number_id !== undefined && patch.wa_phone_number_id !== cur.wa_phone_number_id) Object.assign(patch, { wa_display_phone: '', wa_verified_name: '' });
      if (Object.keys(patch).length || Object.keys(pp).length) {
        patch.updated_at = now();
        patch.last_error = null;
        const keys = Object.keys(patch);
        db.run(`UPDATE meta_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE location_id = ?`, ...keys.map((k) => patch[k]), ctx.locationId);
        tplCache.delete(ctx.locationId);
      }
      return out(account(ctx.locationId)!);
    });

    router.delete('/api/settings/meta', 'location', (ctx) => {
      db.run('DELETE FROM meta_pages WHERE location_id = ?', ctx.locationId);
      db.run('DELETE FROM meta_accounts WHERE location_id = ?', ctx.locationId);
      tplCache.delete(ctx.locationId);
      return { ok: true };
    });

    // --- several pages / Instagram accounts ---------------------------------------------------
    const pageOf = (loc: string, key: string) => {
      const p = db.get<Page>('SELECT * FROM meta_pages WHERE id = ? AND location_id = ?', key, loc);
      if (!p) throw notFound('Seite nicht gefunden');
      return p;
    };
    router.get('/api/settings/meta/pages', 'location', (ctx) => pagesOf(ctx.locationId).map(pageOut));
    router.post('/api/settings/meta/pages', 'location', (ctx) => {
      ensureAccount(ctx.locationId);
      const patch = pagePatch(ctx.locationId, ctx.body ?? {});
      if (!patch.page_id && !patch.ig_account_id) throw bad('Seiten-ID oder Instagram-Konto-ID fehlt');
      if (!patch.page_token) throw bad('Seiten-Token fehlt');
      return pageOut(writePage(ctx.locationId, patch));
    });
    router.patch('/api/settings/meta/pages/:id', 'location', (ctx) => {
      const cur = pageOf(ctx.locationId, ctx.params.id);
      return pageOut(writePage(ctx.locationId, pagePatch(ctx.locationId, ctx.body ?? {}, cur), cur));
    });
    router.delete('/api/settings/meta/pages/:id', 'location', (ctx) => {
      const cur = pageOf(ctx.locationId, ctx.params.id);
      db.run('DELETE FROM meta_pages WHERE id = ?', cur.id);
      return { ok: true };
    });

    /** "Verbindung testen": reads the number and every page and Instagram account with the stored tokens. */
    router.post('/api/settings/meta/test', 'location', async (ctx) => {
      const a = ensureAccount(ctx.locationId);
      const res: Record<string, { ok: boolean; info?: string; error?: string }> = {};
      const attempt = async (key: string, fn: () => Promise<string>) => {
        try {
          res[key] = { ok: true, info: await fn() };
        } catch (e) {
          res[key] = { ok: false, error: (e as Error).message };
        }
      };
      if (configured(a, 'whatsapp')) {
        await attempt('whatsapp', async () => {
          const r = await graph<any>(a, 'whatsapp', 'GET', `${a.wa_phone_number_id}?fields=display_phone_number,verified_name,quality_rating`);
          db.run('UPDATE meta_accounts SET wa_display_phone = ?, wa_verified_name = ? WHERE location_id = ?', String(r?.display_phone_number ?? '').slice(0, 40), String(r?.verified_name ?? '').slice(0, 120), a.location_id);
          let info = [r?.verified_name, r?.display_phone_number].filter(Boolean).join(' · ') || 'verbunden';
          if (r?.quality_rating) info += ` · Qualität ${r.quality_rating}`;
          if (a.wa_business_account_id) {
            const w = await graph<any>(a, 'whatsapp', 'GET', `${a.wa_business_account_id}?fields=name`);
            if (w?.name) info += ` · Konto „${w.name}“`;
          } else info += ' · Business-Konto-ID fehlt (für Vorlagen nötig)';
          return info;
        });
      }
      // The first page keeps the keys `messenger` / `instagram`; further ones add their ID (`messenger:<page id>`).
      let n = 0;
      for (const p of pagesOf(a.location_id)) {
        const suffix = n++ ? `:${p.page_id || p.ig_account_id}` : '';
        if (pageOk(p, 'messenger')) {
          await attempt(`messenger${suffix}`, async () => {
            const r = await graph<any>(a, 'messenger', 'GET', `${p.page_id}?fields=name`, undefined, undefined, p);
            db.run('UPDATE meta_pages SET page_name = ? WHERE id = ?', String(r?.name ?? '').slice(0, 120), p.id);
            return r?.name ? `Seite „${r.name}“` : 'verbunden';
          });
        }
        if (pageOk(p, 'instagram')) {
          await attempt(`instagram${suffix}`, async () => {
            const r = await graph<any>(a, 'instagram', 'GET', `${p.ig_account_id}?fields=username,name`, undefined, undefined, p);
            db.run('UPDATE meta_pages SET ig_username = ? WHERE id = ?', String(r?.username ?? '').slice(0, 60), p.id);
            return r?.username ? `@${r.username}` : 'verbunden';
          });
        }
      }
      if (!Object.keys(res).length) throw bad('Noch kein Kanal vollständig eingetragen (ID + Token)');
      if (!a.app_secret) res.webhook = { ok: false, error: 'App-Secret fehlt – ohne es werden eingehende Nachrichten abgelehnt' };
      return { results: res, settings: out(account(ctx.locationId)!) };
    });

    /** Subscribes the app to the WhatsApp account (with this sub-account's webhook address) and every Facebook page. */
    router.post('/api/settings/meta/subscribe', 'location', async (ctx) => {
      const a = ensureAccount(ctx.locationId);
      const res: Record<string, { ok: boolean; info?: string; error?: string }> = {};
      const url = `${app.baseUrl()}/hooks/meta/${a.location_id}`;
      if (configured(a, 'whatsapp')) {
        if (!a.wa_business_account_id) res.whatsapp = { ok: false, error: 'WhatsApp-Business-Konto-ID fehlt' };
        else if (!url.startsWith('https://')) res.whatsapp = { ok: false, error: 'Braucht eine öffentliche https-Adresse (PGHL_BASE_URL)' };
        else {
          try {
            await graph(a, 'whatsapp', 'POST', `${a.wa_business_account_id}/subscribed_apps`, { override_callback_uri: url, verify_token: a.verify_token });
            res.whatsapp = { ok: true, info: 'App abonniert, Webhook-Adresse gesetzt' };
          } catch (e) {
            res.whatsapp = { ok: false, error: (e as Error).message };
          }
        }
      }
      let n = 0;
      for (const p of pagesOf(a.location_id).filter((x) => pageOk(x, 'messenger'))) {
        const key = `messenger${n++ ? `:${p.page_id}` : ''}`;
        try {
          await graph(a, 'messenger', 'POST', `${p.page_id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,message_deliveries,message_reads,message_reactions`, undefined, undefined, p);
          res[key] = { ok: true, info: `Seite ${p.page_name ? `„${p.page_name}“ ` : ''}abonniert (Messenger und Instagram)` };
        } catch (e) {
          res[key] = { ok: false, error: (e as Error).message };
        }
      }
      if (!Object.keys(res).length) throw bad('Noch kein Kanal vollständig eingetragen (ID + Token)');
      return { results: res };
    });

    // --- workflows + MCP ----------------------------------------------------------------
    app.services.workflowActions = {
      ...(app.services.workflowActions ?? {}),
      /** Text inside the 24-hour window, otherwise the chosen template ("auto"), or always one of the two. */
      whatsapp_send: async (run: any, step: any, vars: Record<string, any>) => {
        const t = (s: unknown) => render(String(s ?? ''), vars);
        const mode = step.mode === 'template' || step.mode === 'text' ? step.mode : 'auto';
        const open = windowState(run.location_id, run.contact_id, 'whatsapp').open;
        const useText = mode === 'text' || (mode === 'auto' && open && !!String(step.body ?? '').trim());
        if (!useText && !step.template) throw new Error(open ? 'Kein Text und keine Vorlage gewählt' : 'Außerhalb des 24-Stunden-Fensters und keine Vorlage gewählt');
        const values = Object.fromEntries(Object.entries(step.values ?? {}).map(([k, v]) => [k, t(v)]));
        const r = await sendMeta(run.location_id, {
          contactId: run.contact_id,
          channel: 'whatsapp',
          ...(useText ? { body: t(step.body) } : { template: { name: String(step.template), language: step.language ? String(step.language) : undefined, values } }),
          source: 'Workflow',
        });
        if (r.status === 'failed') throw new Error(r.error);
        return useText ? 'Text gesendet' : `Vorlage ${step.template} gesendet`;
      },
    };
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
