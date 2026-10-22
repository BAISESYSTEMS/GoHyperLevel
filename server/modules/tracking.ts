import type { App, Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, notFound, redirect, str, type Ctx } from '../core/http.js';
import { id, now, sha256, slugify } from '../core/util.js';
import { addTags, getContact, logActivity } from '../services/contacts.js';
import { commitClicks, machineBreakdown, pruneEvents, recordHit } from '../services/email-events.js';

/**
 * Email open/click tracking and GHL-style trigger links:
 * - every link in an outgoing email goes through /t/c/<id>, and a 1×1 pixel reports the open (the pixel can be
 *   switched off per sub-account: settings.email.track_opens = false, links are still tracked; for business mails only:
 *   settings.email.track_business_opens = false); the double opt-in mail is never instrumented;
 * - every hit is classified (person / mail-provider proxy / security scanner, services/email-classify.ts) and stored
 *   in email_events; only people's hits count (opened_at, clicked_at, reports, `email.opened` / `email.clicked`),
 *   machine hits only raise machine_open_count / machine_click_count – see docs/email-tracking.md;
 * - trigger links (/l/<slug>) work anywhere (SMS, social, print); in messages they become personal,
 *   so a click can tag the contact and start workflows.
 */

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export function personalSig(app: App, contactId: string, slug: string) {
  return sha256(`${app.config.secret}:link:${contactId}:${slug}`).slice(0, 16);
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const trackingModule: Module = {
  name: 'tracking',
  migrations: [
    [
      '001-init',
      `
      ALTER TABLE messages ADD COLUMN opened_at TEXT;
      ALTER TABLE messages ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN clicked_at TEXT;
      ALTER TABLE messages ADD COLUMN click_count INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE tracked_links (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL, message_id TEXT NOT NULL, contact_id TEXT,
        url TEXT NOT NULL, clicks INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX tracked_links_msg ON tracked_links(message_id);
      CREATE TABLE trigger_links (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
        clicks INTEGER NOT NULL DEFAULT 0, unique_contacts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE TABLE trigger_link_clicks (
        link_id TEXT NOT NULL REFERENCES trigger_links(id) ON DELETE CASCADE, contact_id TEXT, at TEXT NOT NULL
      );
      `,
    ],
    [
      // Opens and clicks of people vs machines. opened_at / open_count / clicked_at / click_count / tracked_links.clicks keep
      // their meaning and column names but now count people only; what machines did is in machine_* and in the event log.
      '002-events',
      `
      ALTER TABLE messages ADD COLUMN machine_open_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE messages ADD COLUMN machine_click_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tracked_links ADD COLUMN machine_clicks INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE email_events (
        id TEXT PRIMARY KEY,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        contact_id TEXT,
        link_id TEXT,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'GET',
        ua_class TEXT NOT NULL DEFAULT '',
        ua_hash TEXT NOT NULL DEFAULT '',
        ip_prefix TEXT NOT NULL DEFAULT '',
        classification TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        applied INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX email_events_msg ON email_events(message_id, at);
      CREATE INDEX email_events_loc ON email_events(location_id, at);
      CREATE INDEX email_events_pending ON email_events(applied, at) WHERE applied = 0;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    let lastPrune = 0;
    const trackingOn = (locationId: string) => app.location(locationId)?.settings.email?.tracking !== false;
    /** The pixel is optional (privacy): settings.email.track_opens = false keeps click tracking but inserts no pixel. */
    const opensOn = (locationId: string) => app.location(locationId)?.settings.email?.track_opens !== false;
    /** Business mails (purpose "transactional": invoice, quote, dunning, appointment, SEPA …): settings.email.track_business_opens = false leaves the pixel out of them only. */
    const businessOpensOn = (locationId: string) => app.location(locationId)?.settings.email?.track_business_opens !== false;

    // `purpose` (services/messaging.ts messagePurpose): what the mail is; mails that must not be measured at all (double opt-in) never get here.
    app.services.instrumentEmail = ({ locationId, messageId, contactId, html, purpose }: { locationId: string; messageId: string; contactId?: string; html: string; purpose?: string }) => {
      if (!trackingOn(locationId)) return html;
      const base = app.baseUrl();
      const seen = new Map<string, string>();
      const out = html.replace(/href="(https?:\/\/[^"]+)"/gi, (m, rawUrl: string) => {
        const url = rawUrl.replace(/&amp;/g, '&');
        // Unsubscribe, preference-centre and trigger links stay direct; they are tracked on their own.
        if (url.startsWith(`${base}/u/`) || url.startsWith(`${base}/l/`) || url.startsWith(`${base}/consent/`)) return m;
        let lid = seen.get(url);
        if (!lid) {
          lid = id(12);
          seen.set(url, lid);
          db.insert('tracked_links', { id: lid, location_id: locationId, message_id: messageId, contact_id: contactId || null, url, created_at: now() });
        }
        return `href="${base}/t/c/${lid}"`;
      });
      if (!opensOn(locationId) || (purpose === 'transactional' && !businessOpensOn(locationId))) return out;
      const pixel = `<img src="${base}/t/o/${messageId}.gif" width="1" height="1" alt="" style="display:none">`;
      return out.includes('</body>') ? out.replace('</body>', `${pixel}</body>`) : out + pixel;
    };

    // Applies the clicks whose hold is over (all of them with force – tests); the tick does the same as a backstop.
    app.services.trackingCommit = (opts?: { force?: boolean }) => commitClicks(app, opts?.force === true);
    app.onTick(() => {
      commitClicks(app);
      if (Date.now() - lastPrune > 3600_000) {
        lastPrune = Date.now();
        pruneEvents(app);
      }
    });

    app.services.personalizeLinks = (locationId: string, contactId: string, body: string) => {
      const base = escRe(app.baseUrl());
      return body.replace(new RegExp(`${base}/l/([a-z0-9-]+)(?![\\w/-])`, 'g'), (m, slug: string) => {
        const link = db.get('SELECT id FROM trigger_links WHERE slug = ? AND location_id = ?', slug, locationId);
        return link ? `${app.baseUrl()}/l/${slug}/${contactId}.${personalSig(app, contactId, slug)}` : m;
      });
    };

    // --- public endpoints -------------------------------------------------------------
    // A person, a mail provider's proxy and a security scanner all land here. Everything is recorded with a verdict
    // (services/email-events.ts); the pixel and the link answer the same for all of them – a click always redirects.
    const record = (ctx: Ctx, kind: 'open' | 'click', messageId: string, linkId?: string) => {
      try {
        recordHit(app, { kind, messageId, linkId, method: ctx.method, headers: ctx.req.headers, ip: ctx.ip });
      } catch (e) {
        console.error('[tracking]', e);
      }
    };
    const pixel = (ctx: Ctx) => {
      record(ctx, 'open', ctx.params.id.replace(/\.gif$/, ''));
      return { __raw: true as const, status: 200, headers: { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' }, body: PIXEL };
    };
    const follow = (ctx: Ctx) => {
      const l = db.get('SELECT * FROM tracked_links WHERE id = ?', ctx.params.id);
      if (!l || !/^https?:\/\//.test(l.url)) throw notFound();
      record(ctx, 'click', l.message_id, l.id);
      return redirect(l.url);
    };
    // HEAD is answered like GET (a scanner that gets a 404 on its HEAD request flags the link as dead).
    router.get('/t/o/:id', 'public', pixel);
    router.add('HEAD', '/t/o/:id', 'public', pixel);
    router.get('/t/c/:id', 'public', follow);
    router.add('HEAD', '/t/c/:id', 'public', follow);

    const followTrigger = (slug: string, contactId?: string) => {
      const link = parseRows(db.all('SELECT * FROM trigger_links WHERE slug = ?', slug), ['tags'])[0];
      if (!link) throw notFound();
      db.run('UPDATE trigger_links SET clicks = clicks + 1 WHERE id = ?', link.id);
      if (contactId && getContact(app, link.location_id, contactId)) {
        const before = db.get('SELECT 1 AS x FROM trigger_link_clicks WHERE link_id = ? AND contact_id = ?', link.id, contactId);
        db.insert('trigger_link_clicks', { link_id: link.id, contact_id: contactId, at: now() });
        if (!before) db.run('UPDATE trigger_links SET unique_contacts = unique_contacts + 1 WHERE id = ?', link.id);
        if (link.tags.length) addTags(app, link.location_id, contactId, link.tags);
        logActivity(app, link.location_id, contactId, 'link.clicked', `Trigger-Link „${link.name}“ geklickt`);
        app.events.emit(link.location_id, 'link.clicked', { contactId, linkId: link.id, slug, url: link.url });
      } else db.insert('trigger_link_clicks', { link_id: link.id, contact_id: null, at: now() });
      return redirect(link.url);
    };
    router.get('/l/:slug', 'public', (ctx) => followTrigger(ctx.params.slug));
    router.get('/l/:slug/:who', 'public', (ctx) => {
      const [cid, sig] = ctx.params.who.split('.');
      const ok = cid && sig && sig === personalSig(app, cid, ctx.params.slug);
      return followTrigger(ctx.params.slug, ok ? cid : undefined);
    });

    // --- trigger links admin -------------------------------------------------------------
    const out = (l: any) => ({ ...l, short_url: `${app.baseUrl()}/l/${l.slug}` });
    router.get('/api/trigger-links', 'location', (ctx) => parseRows(db.all('SELECT * FROM trigger_links WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId), ['tags']).map(out));
    router.post('/api/trigger-links', 'location', (ctx) => {
      const url = str(ctx.body.url, 'Ziel-URL', { required: true, max: 2000 });
      if (!/^https?:\/\//.test(url)) throw bad('Ziel-URL muss mit http(s):// beginnen');
      const name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      let slug = slugify(ctx.body.slug || name);
      for (let i = 2; db.get('SELECT id FROM trigger_links WHERE slug = ?', slug); i++) slug = `${slugify(ctx.body.slug || name)}-${i}`;
      const row = { id: id(), location_id: ctx.locationId, name, slug, url, tags: Array.isArray(ctx.body.tags) ? ctx.body.tags.map(String) : [], created_at: now() };
      db.insert('trigger_links', row);
      return out({ ...row, clicks: 0, unique_contacts: 0 });
    });
    router.patch('/api/trigger-links/:id', 'location', (ctx) => {
      const patch: Record<string, any> = {};
      if (ctx.body.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true });
      if (ctx.body.url !== undefined) {
        if (!/^https?:\/\//.test(ctx.body.url)) throw bad('Ziel-URL muss mit http(s):// beginnen');
        patch.url = String(ctx.body.url);
      }
      if (Array.isArray(ctx.body.tags)) patch.tags = ctx.body.tags.map(String);
      if (!db.update('trigger_links', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return out(parseRows(db.all('SELECT * FROM trigger_links WHERE id = ?', ctx.params.id), ['tags'])[0]);
    });
    router.delete('/api/trigger-links/:id', 'location', (ctx) => {
      db.run('DELETE FROM trigger_links WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- engagement stats -----------------------------------------------------------------------
    // opened / clicked are people (messages.opened_at / clicked_at); machine_* is what proxies and scanners did.
    router.get('/api/campaigns/:id/engagement', 'location', (ctx) => {
      const c = db.get('SELECT id FROM campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      const r = db.get(
        `SELECT COUNT(m.id) AS sent, SUM(CASE WHEN m.opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                SUM(CASE WHEN m.clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked,
                SUM(CASE WHEN m.opened_at IS NULL AND m.machine_open_count > 0 THEN 1 ELSE 0 END) AS machine_opened,
                SUM(CASE WHEN m.clicked_at IS NULL AND m.machine_click_count > 0 THEN 1 ELSE 0 END) AS machine_clicked,
                SUM(m.machine_open_count) AS machine_open_events, SUM(m.machine_click_count) AS machine_click_events
         FROM campaign_recipients r JOIN messages m ON m.id = r.message_id WHERE r.campaign_id = ? AND m.status IN ('sent','logged')`,
        c.id,
      )!;
      const links = db.all(
        `SELECT l.url, SUM(l.clicks) AS clicks, SUM(l.machine_clicks) AS machine_clicks, COUNT(DISTINCT CASE WHEN l.clicks > 0 THEN m.contact_id END) AS people
         FROM tracked_links l JOIN campaign_recipients r ON r.message_id = l.message_id JOIN messages m ON m.id = l.message_id WHERE r.campaign_id = ? GROUP BY l.url ORDER BY clicks DESC, machine_clicks DESC`,
        c.id,
      );
      const machine = machineBreakdown(app, `e.message_id IN (SELECT message_id FROM campaign_recipients WHERE campaign_id = ?)`, c.id);
      const sent = Number(r.sent) || 0;
      const pct = (n: number) => (sent ? Math.round((n / sent) * 1000) / 10 : 0);
      const n = (v: unknown) => Number(v) || 0;
      return {
        sent,
        opened: n(r.opened),
        clicked: n(r.clicked),
        open_rate: pct(n(r.opened)),
        click_rate: pct(n(r.clicked)),
        machine_opened: n(r.machine_opened),
        machine_clicked: n(r.machine_clicked),
        machine_open_events: n(r.machine_open_events),
        machine_click_events: n(r.machine_click_events),
        machine,
        links,
      };
    });
  },
};
