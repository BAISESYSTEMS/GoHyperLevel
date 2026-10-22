import { smartListById, type ListReader } from '../services/smart-lists.js';
import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now } from '../core/util.js';
import { contactVars, getContact } from '../services/contacts.js';
import { sendToContact } from '../services/messaging.js';
import { assertCampaignDesign, designPatch } from '../services/email-design.js';
import { cleanSpeed, throttleInfo, tickLength, warmupAdvice } from '../services/campaign-throttle.js';
import { CAMPAIGN_JSON, audience, blockedContacts, createResend, defaultBatchOf, handled, parseCampaign, reachable, releaseWinner, runTick, sendBatch, startSending } from '../services/campaign-run.js';
import { abResults, cleanAbConfig, cleanSender, variantContent } from '../services/mk-ab.js';
import { cleanResendConfig, dueAt, nonOpenerIds } from '../services/mk-resend.js';
import { getSettings } from '../services/mk-settings.js';
import { loadBuckets, planHours } from '../services/mk-sto.js';
import { cleanWaTemplate, resolveWaTemplate } from '../services/mk-whatsapp.js';
import type { Tool } from './mcp.js';

const CHANNELS = ['email', 'sms', 'whatsapp'];
const channelOf = (v: unknown) => (CHANNELS.includes(String(v)) ? String(v) : 'email');

const TOOLS: Tool[] = [
  {
    name: 'ghl_campaign_ab_results',
    title: 'A/B-Test einer Kampagne',
    description:
      'Ergebnis des A/B-Tests einer E-Mail-Kampagne: je Variante (A–D) Betreff, Gesendet, Öffnungen und Klicks von Personen (Maschinen zählen nicht), Käufer und Umsatz, dazu Einschätzung gegen das Original, Stand (Test läuft / wartet auf Entscheidung / Gewinner), Entscheidungszeit und – falls eingerichtet – die Erinnerung an Nicht-Öffner. Ohne campaign_id: die Kampagnen mit A/B-Test oder Erinnerung.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, campaign_id: { type: 'string', description: 'Kampagne; leer = Liste der Kampagnen mit Test' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (!a.campaign_id) {
        const list: any[] = await call.api('GET', '/api/campaigns', { location: a.location_id });
        return list.filter((c) => c.ab || c.parent_id).map((c) => ({ id: c.id, name: c.name, status: c.status, ab: c.ab, reminder_of: c.parent_id ?? null, sent: c.stats?.sent ?? 0, held: c.stats?.held ?? 0 }));
      }
      const c = await call.api('GET', `/api/campaigns/${encodeURIComponent(a.campaign_id)}`, { location: a.location_id });
      return { id: c.id, name: c.name, status: c.status, subject: c.subject, ab: c.ab_results ?? null, resend: c.resend_info ?? null };
    },
  },
];

export const campaignsModule: Module = {
  name: 'campaigns',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE campaigns (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        is_html INTEGER NOT NULL DEFAULT 0, filter TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'draft',
        scheduled_at TEXT, started_at TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE campaign_recipients (
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', message_id TEXT, sent_at TEXT,
        PRIMARY KEY (campaign_id, contact_id)
      );
      CREATE TABLE templates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT 'email', subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        is_html INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      `,
    ],
    [
      '002-email-design',
      `
      ALTER TABLE campaigns ADD COLUMN design TEXT;
      ALTER TABLE campaigns ADD COLUMN body_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE templates ADD COLUMN design TEXT;
      ALTER TABLE templates ADD COLUMN body_text TEXT NOT NULL DEFAULT '';
      `,
    ],
    // Sending speed per campaign (messages per hour, NULL = standard) and the point it counts from (services/campaign-throttle.ts).
    [
      '003-throttle',
      `
      ALTER TABLE campaigns ADD COLUMN speed_per_hour INTEGER;
      ALTER TABLE campaigns ADD COLUMN throttle_at TEXT;
      ALTER TABLE campaigns ADD COLUMN throttle_sent INTEGER NOT NULL DEFAULT 0;
      `,
    ],
    // Marketing depth (docs/email-marketing.md): A/B test and non-opener follow-up as JSON setups with their state, send-time
    // optimisation, an own sender name, a WhatsApp template, the campaign a follow-up belongs to; the variant and the send time of
    // every recipient; the settings of the marketing extras of a sub-account.
    [
      '004-marketing',
      `
      ALTER TABLE campaigns ADD COLUMN ab TEXT;
      ALTER TABLE campaigns ADD COLUMN resend TEXT;
      ALTER TABLE campaigns ADD COLUMN send_mode TEXT NOT NULL DEFAULT 'now';
      ALTER TABLE campaigns ADD COLUMN sender_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE campaigns ADD COLUMN wa_template TEXT;
      ALTER TABLE campaigns ADD COLUMN parent_id TEXT;
      ALTER TABLE campaign_recipients ADD COLUMN variant TEXT NOT NULL DEFAULT '';
      ALTER TABLE campaign_recipients ADD COLUMN send_at TEXT;
      CREATE INDEX campaign_recipients_due ON campaign_recipients(campaign_id, status, send_at);
      CREATE INDEX campaigns_loc_status ON campaigns(location_id, status);
      CREATE TABLE mk_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    // Campaign and template bodies are JSON objects. An array hands its methods to the field checks (`body.filter` is
    // Array.prototype.filter) and ended as a 500; top-level arrays stay allowed elsewhere (webhooks), so the check lives here.
    app.guards.push((ctx) => {
      if (!['POST', 'PUT', 'PATCH'].includes(ctx.method) || !/^\/api\/(campaigns|templates)(\/|$)/.test(ctx.path)) return;
      if (typeof ctx.body !== 'object' || ctx.body === null || Array.isArray(ctx.body)) throw bad('Ungültige Daten: bitte ein JSON-Objekt senden');
    });
    // `design` (email builder) is rendered into body/body_text on save, see services/email-design.ts.
    const get = (loc: string, cid: string) => parseCampaign(db.get('SELECT * FROM campaigns WHERE id = ? AND location_id = ?', cid, loc));
    const stats = (cid: string) =>
      Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status', cid).map((r) => [r.status, r.n]));
    /** The list stays light: an A/B test shows its state, not its variants' contents. */
    const slim = (c: any) => ({ ...c, ab: c.ab ? { enabled: !!c.ab.enabled, phase: c.ab.phase ?? null, winner: c.ab.winner ?? null, metric: c.ab.metric, variants: c.ab.variants?.length ?? 0 } : null, design: undefined, body: undefined, body_text: undefined });

    /** A smart list in the audience must be one the person may load – another person's private list counts as missing. */
    const checkList = <T,>(ctx: Ctx, filter: T): T => {
      const sid = (filter as any)?.smart_list_id;
      if (sid && !smartListById(app, ctx.locationId, sid, ctx)) throw bad('Smart List nicht gefunden');
      return filter;
    };
    router.get('/api/campaigns', 'location', (ctx) =>
      parseRows(db.all('SELECT * FROM campaigns WHERE location_id = ? ORDER BY created_at DESC', ctx.locationId), CAMPAIGN_JSON).map((c) => ({ ...slim(c), stats: stats(c.id) })),
    );
    /** Speed, remaining messages with the time they need, and the hint for new senders. */
    const throttleOf = (c: any, who: ListReader) => {
      const loc = app.location(c.location_id)!;
      const st = stats(c.id);
      const remaining = c.status === 'sending' ? (st.pending ?? 0) : ['draft', 'scheduled'].includes(c.status) ? audience(app, c.location_id, c.filter, who).filter((x) => reachable(x, c.channel)).length : 0;
      const throttle = throttleInfo({ speed: c.speed_per_hour ?? null, defaultBatch: defaultBatchOf(loc), tickMs: tickLength(app.config.tickMs), remaining });
      // Counting stops at the "new sender" limit, so this stays cheap on big accounts.
      const sentTotal = db.get<{ n: number }>(`SELECT COUNT(*) n FROM (SELECT 1 FROM messages WHERE location_id = ? AND channel = 'email' AND direction = 'out' AND status IN ('sent', 'delivered', 'read') LIMIT 1000)`, c.location_id)!.n;
      return { throttle, warmup: warmupAdvice({ channel: c.channel, sentTotal, remaining, perHour: throttle.per_hour }) };
    };
    /** What the page needs besides the row: results of an A/B test, the follow-up, the warm-up plan and the reputation verdict. */
    const extrasOf = (c: any) => ({
      ab_results: c.ab?.enabled ? abResults(app, c) : null,
      resend_info: c.resend?.enabled
        ? { ...c.resend, due_at: c.sent_at ? dueAt(c.resend, c.sent_at) : null, preview: c.status === 'sent' && c.resend.status === 'waiting' ? nonOpenerIds(app, c.id, c.location_id).length : null }
        : null,
      plan: app.services.mkWarmup?.state?.(c.location_id) ?? null,
      reputation: c.channel === 'email' ? (app.services.mkReputation?.(c.location_id) ?? null) : null,
    });
    router.get('/api/campaigns/:id', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      return { ...c, stats: stats(c.id), audience: c.status === 'draft' ? audience(app, ctx.locationId, c.filter, ctx).length : undefined, ...throttleOf(c, ctx), ...extrasOf(c) };
    });
    /** Changes the speed of a campaign – also while it is sending (the new speed counts from now on). */
    router.put('/api/campaigns/:id/speed', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (!['draft', 'scheduled', 'sending'].includes(c.status)) throw bad('Diese Kampagne ist schon versendet');
      const speed = cleanSpeed(ctx.body?.speed_per_hour);
      db.run('UPDATE campaigns SET speed_per_hour = ?, throttle_at = ?, throttle_sent = ?, updated_at = ? WHERE id = ?', speed, now(), handled(app, c.id), now(), c.id);
      const next = get(ctx.locationId, c.id);
      return { ...next, stats: stats(c.id), ...throttleOf(next, ctx) };
    });
    router.post('/api/campaigns', 'location', (ctx) => {
      const channel = channelOf(ctx.body.channel);
      const row: Record<string, any> = {
        id: id(),
        location_id: ctx.locationId,
        name: str(ctx.body.name, 'Name', { required: true, max: 200 }),
        channel,
        subject: str(ctx.body.subject, 'Betreff', { max: 300 }),
        body: str(ctx.body.body, 'Text', { max: 200_000 }),
        is_html: ctx.body.is_html ? 1 : 0,
        filter: checkList(ctx, ctx.body.filter ?? {}),
        status: 'draft',
        speed_per_hour: cleanSpeed(ctx.body.speed_per_hour),
        send_mode: channel === 'email' && ctx.body.send_mode === 'sto' ? 'sto' : 'now',
        sender_name: channel === 'email' ? cleanSender(ctx.body.sender_name) : '',
        created_at: now(),
        updated_at: now(),
        ...(channel === 'email' ? designPatch(ctx.body) : {}),
      };
      if (channel === 'whatsapp') row.wa_template = cleanWaTemplate(ctx.body.wa_template);
      if (channel === 'email' && ctx.body.ab) row.ab = cleanAbConfig(ctx.body.ab, { channel, subject: row.subject });
      if (channel === 'email' && ctx.body.resend) row.resend = cleanResendConfig(ctx.body.resend, { channel, subject: row.subject });
      db.insert('campaigns', row);
      return row;
    });
    router.patch('/api/campaigns/:id', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (!['draft', 'scheduled'].includes(c.status)) throw bad('Versendete Kampagnen lassen sich nicht ändern');
      const patch: Record<string, any> = { updated_at: now() };
      for (const k of ['name', 'subject', 'body']) if (ctx.body[k] !== undefined) patch[k] = str(ctx.body[k], k, { max: 200_000 });
      if (ctx.body.channel !== undefined) patch.channel = channelOf(ctx.body.channel);
      if (ctx.body.is_html !== undefined) patch.is_html = ctx.body.is_html ? 1 : 0;
      if (ctx.body.filter !== undefined) patch.filter = checkList(ctx, ctx.body.filter);
      if (ctx.body.speed_per_hour !== undefined) patch.speed_per_hour = cleanSpeed(ctx.body.speed_per_hour);
      const channel: string = patch.channel ?? c.channel;
      const subject: string = patch.subject ?? c.subject;
      if (channel === 'email') {
        Object.assign(patch, designPatch(ctx.body, c));
        if (ctx.body.send_mode !== undefined) patch.send_mode = ctx.body.send_mode === 'sto' ? 'sto' : 'now';
        if (ctx.body.sender_name !== undefined) patch.sender_name = cleanSender(ctx.body.sender_name);
        if (ctx.body.ab !== undefined) patch.ab = cleanAbConfig(ctx.body.ab, { channel, subject });
        if (ctx.body.resend !== undefined) patch.resend = cleanResendConfig(ctx.body.resend, { channel, subject, parent_id: c.parent_id });
      } else {
        // Only e-mail has a designer, tests, sender names, send times and follow-ups.
        Object.assign(patch, { ab: null, resend: null, send_mode: 'now', sender_name: '' });
      }
      if (channel === 'whatsapp' && ctx.body.wa_template !== undefined) patch.wa_template = cleanWaTemplate(ctx.body.wa_template);
      if (channel !== 'whatsapp') patch.wa_template = null;
      // A scheduled campaign must keep its footer when the design changes.
      if (c.status === 'scheduled' && patch.design) assertCampaignDesign(patch.design, { location: app.location(ctx.locationId) });
      db.update('campaigns', c.id, patch);
      return get(ctx.locationId, c.id);
    });
    router.delete('/api/campaigns/:id', 'location', (ctx) => {
      db.run('DELETE FROM campaigns WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    router.post('/api/campaigns/:id/audience', 'location', (ctx) => {
      checkList(ctx, ctx.body.filter);
      const list = audience(app, ctx.locationId, ctx.body.filter ?? {}, ctx);
      const channel = channelOf(ctx.body.channel);
      const withAddress = list.filter((c) => reachable(c, channel));
      // The consent gate (and the address check) as the campaign itself will apply them.
      // For WhatsApp the template's category decides (read from Meta when the campaign is checked; the browser may tell what it saw in the list).
      const stored = channel === 'whatsapp' ? get(ctx.locationId, ctx.params.id)?.wa_template : undefined;
      const wa = { category: stored?.category ?? (typeof ctx.body.wa_category === 'string' ? ctx.body.wa_category : undefined) };
      const blocked = blockedContacts(app, { location_id: ctx.locationId, channel, wa_template: wa }, withAddress);
      const noConsent = [...blocked.values()].filter((r) => !/E-Mail-Adresse/.test(r)).length;
      const badAddress = blocked.size - noConsent;
      return { total: list.length, reachable: withAddress.length - blocked.size, ...(noConsent ? { no_consent: noConsent } : {}), ...(badAddress ? { bad_address: badAddress } : {}) };
    });

    /** Send-time optimisation: what the current audience would get – their own hour, the sub-account's, the default. */
    router.get('/api/campaigns/:id/sto', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      const tz = app.location(ctx.locationId)?.timezone ?? 'Europe/Berlin';
      const contacts = audience(app, ctx.locationId, c.filter, ctx).filter((x) => reachable(x, c.channel));
      const hours = planHours(loadBuckets(app, ctx.locationId), tz, getSettings(app, ctx.locationId).sto.default_hour);
      const spread = new Array<number>(24).fill(0);
      let own = 0;
      for (const x of contacts) {
        const h = hours.own.get(x.id);
        if (h !== undefined) own++;
        spread[h ?? hours.fallback]++;
      }
      return { recipients: contacts.length, own, fallback: contacts.length - own, fallback_hour: hours.fallback, fallback_from: hours.fallback_from, by_hour: spread, timezone: tz };
    });

    router.post('/api/campaigns/:id/send', 'location', async (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (!['draft', 'scheduled'].includes(c.status)) throw bad('Schon versendet');
      if (c.channel === 'whatsapp') {
        // The template must exist and be approved; its category (read from Meta) decides whether the consent gate applies.
        const wa = await resolveWaTemplate(app, ctx.locationId, c.wa_template);
        c.wa_template = { name: wa.name, language: wa.language, category: wa.category, values: wa.values };
        db.update('campaigns', c.id, { wa_template: c.wa_template });
      } else if (!c.body) throw bad('Text fehlt');
      if (c.channel === 'email' && !c.subject) throw bad('Betreff fehlt');
      if (c.channel === 'email') {
        assertCampaignDesign(c.design, { location: app.location(ctx.locationId) });
        for (const v of c.ab?.enabled ? c.ab.variants : []) if (v.design) assertCampaignDesign(v.design, { location: app.location(ctx.locationId) });
      }
      checkList(ctx, c.filter);
      if (ctx.body.scheduled_at) {
        const at = new Date(ctx.body.scheduled_at);
        if (Number.isNaN(at.getTime())) throw bad('Ungültiger Zeitpunkt');
        db.run(`UPDATE campaigns SET status = 'scheduled', scheduled_at = ? WHERE id = ?`, at.toISOString(), c.id);
        return get(ctx.locationId, c.id);
      }
      const n = startSending(app, c);
      await sendBatch(app, get(ctx.locationId, c.id));
      return { ...get(ctx.locationId, c.id), recipients: n };
    });
    router.post('/api/campaigns/:id/cancel', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      db.run(`UPDATE campaign_recipients SET status = 'skipped', error = 'abgebrochen' WHERE campaign_id = ? AND status IN ('pending', 'held')`, c.id);
      db.run(`UPDATE campaigns SET status = CASE WHEN status = 'scheduled' THEN 'draft' ELSE 'sent' END WHERE id = ?`, c.id);
      return get(ctx.locationId, c.id);
    });
    router.post('/api/campaigns/:id/test', 'location', async (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      const contact = getContact(app, ctx.locationId, str(ctx.body.contact_id, 'Testkontakt', { required: true }));
      if (!contact) throw notFound('Kontakt nicht gefunden');
      const vars = { contact: contactVars(contact), location: app.location(ctx.locationId) };
      if (c.channel === 'whatsapp') {
        const wa = await resolveWaTemplate(app, ctx.locationId, c.wa_template);
        const values = Object.fromEntries(Object.entries(wa.values).map(([k, v]) => [k, render(String(v), vars)]));
        return app.services.metaSend(ctx.locationId, { contactId: contact.id, channel: 'whatsapp', template: { name: wa.name, language: wa.language, values }, source: 'Kampagnen-Test', ignoreDnd: true });
      }
      // A variant of an A/B test can be tried out on its own.
      const v = variantContent(c, String(ctx.body.variant ?? ''));
      return sendToContact(app, ctx.locationId, {
        contactId: contact.id,
        channel: c.channel,
        subject: `[TEST] ${render(v.subject, vars)}`,
        body: render(v.body, vars, { escape: !!v.is_html }),
        text: v.body_text ? render(v.body_text, vars) : undefined,
        isHtml: !!v.is_html,
        source: 'Kampagnen-Test',
        ignoreDnd: true,
        ...(c.channel === 'email' && v.sender_name ? { fromName: render(v.sender_name, vars) } : {}),
      });
    });
    router.get('/api/campaigns/:id/recipients', 'location', (ctx) =>
      db.all(
        `SELECT r.*, c.first_name, c.last_name, c.email, c.phone FROM campaign_recipients r LEFT JOIN contacts c ON c.id = r.contact_id
         WHERE r.campaign_id = ? AND EXISTS (SELECT 1 FROM campaigns k WHERE k.id = r.campaign_id AND k.location_id = ?) ORDER BY r.sent_at DESC LIMIT 2000`,
        ctx.params.id,
        ctx.locationId,
      ),
    );

    // --- A/B test: results and the manual choice of the winner ---------------------------------------------------------
    router.get('/api/campaigns/:id/ab', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      return abResults(app, c) ?? { enabled: false };
    });
    /** While the test waits, the winner can be chosen at once (key) or the automatic decision can be taken now (no key). */
    router.post('/api/campaigns/:id/ab/winner', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (!c.ab?.enabled || c.status !== 'testing' || c.ab.phase !== 'waiting') throw bad('Der Gewinner lässt sich nur wählen, solange der Test auf die Entscheidung wartet');
      const key = ctx.body?.key === undefined || ctx.body?.key === '' ? undefined : String(ctx.body.key);
      if (key && !c.ab.variants.some((v: { key: string }) => v.key === key)) throw bad('Unbekannte Variante');
      const r = releaseWinner(app, c, key ? 'manual' : 'auto', key);
      return { ...r, ...abResults(app, get(ctx.locationId, c.id)) };
    });

    // --- follow-up to non-openers ---------------------------------------------------------------------------------------
    /**
     * Sets up (or, with `now`, starts at once) the follow-up for a campaign that is already sending or sent – the setup of a
     * draft goes through PATCH. Once the follow-up exists, it cannot be set up again.
     */
    router.post('/api/campaigns/:id/resend', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (c.channel !== 'email') throw bad('„Erneut an Nicht-Öffner“ gibt es nur für E-Mail-Kampagnen');
      if (!['sent', 'sending', 'testing'].includes(c.status)) throw bad('Für Entwürfe und geplante Kampagnen den Betreff direkt in der Kampagne einstellen');
      if (c.resend?.status === 'created') throw bad('Die Erinnerung ist schon erstellt');
      const cfg = cleanResendConfig({ ...ctx.body, enabled: true }, { channel: c.channel, subject: c.subject, parent_id: c.parent_id })!;
      db.run('UPDATE campaigns SET resend = ? WHERE id = ?', JSON.stringify(cfg), c.id);
      if (ctx.body?.now === true) {
        if (c.status !== 'sent') throw bad('Die Erinnerung geht erst, wenn die Kampagne fertig versendet ist');
        const child = createResend(app, { ...c, resend: cfg });
        return { ...extrasOf(get(ctx.locationId, c.id)), child_id: child };
      }
      return extrasOf(get(ctx.locationId, c.id));
    });
    router.delete('/api/campaigns/:id/resend', 'location', (ctx) => {
      const c = get(ctx.locationId, ctx.params.id);
      if (!c) throw notFound();
      if (c.resend?.status === 'created') throw bad('Die Erinnerung ist schon erstellt');
      db.run('UPDATE campaigns SET resend = NULL WHERE id = ?', c.id);
      return { ok: true };
    });

    // --- reusable templates (email & SMS snippets) --------------------------
    const getTemplate = (tid: string) => parseJson(db.get('SELECT * FROM templates WHERE id = ?', tid), ['design']);
    router.get('/api/templates', 'location', (ctx) => parseRows(db.all('SELECT * FROM templates WHERE location_id = ? ORDER BY name', ctx.locationId), ['design']));
    router.get('/api/templates/:id', 'location', (ctx) => {
      const t = getTemplate(ctx.params.id);
      if (!t || t.location_id !== ctx.locationId) throw notFound();
      return t;
    });
    router.post('/api/templates', 'location', (ctx) => {
      const row = { id: id(), location_id: ctx.locationId, name: str(ctx.body.name, 'Name', { required: true }), channel: ctx.body.channel === 'sms' ? 'sms' : 'email', subject: str(ctx.body.subject, 'Betreff'), body: str(ctx.body.body, 'Text', { max: 200_000 }), is_html: ctx.body.is_html ? 1 : 0, created_at: now(), updated_at: now(), ...(ctx.body.channel === 'sms' ? {} : designPatch(ctx.body)) };
      db.insert('templates', row);
      return row;
    });
    router.patch('/api/templates/:id', 'location', (ctx) => {
      const current = getTemplate(ctx.params.id);
      if (!current || current.location_id !== ctx.locationId) throw notFound();
      const patch: Record<string, any> = { updated_at: now() };
      for (const k of ['name', 'subject', 'body']) if (ctx.body[k] !== undefined) patch[k] = String(ctx.body[k]);
      if (ctx.body.channel !== undefined) patch.channel = ctx.body.channel === 'sms' ? 'sms' : 'email';
      if (ctx.body.is_html !== undefined) patch.is_html = ctx.body.is_html ? 1 : 0;
      Object.assign(patch, designPatch(ctx.body, current));
      if (!db.update('templates', ctx.params.id, patch, ctx.locationId)) throw notFound();
      return getTemplate(ctx.params.id);
    });
    router.delete('/api/templates/:id', 'location', (ctx) => {
      db.run('DELETE FROM templates WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    app.onTick(() => runTick(app));
  },
};

