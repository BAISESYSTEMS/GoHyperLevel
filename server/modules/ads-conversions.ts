import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { googleApi } from '../services/ads-google.js';
import {
  BATCH,
  DEFAULT_GCONV,
  G_EVENT_LABEL,
  G_EVENTS,
  clickConversion,
  cleanConfig,
  googleClick,
  splitResults,
  uploadClickConversions,
  userIdentifiers,
  type GConvConfig,
  type GEvent,
} from '../services/ads-gconv.js';
import { fetcherOf, googleAuth, googleCreds, googleReady, loadConnection } from '../services/ads-store.js';
import type { TouchRow } from '../services/attribution.js';
import { getContact } from '../services/contacts.js';

/**
 * Google Ads offline conversions – the Google counterpart of the Meta Conversions API in ads.ts: configurable CRM events (deal
 * won with its value and currency, form submitted, appointment booked, invoice paid) go into a queue and are uploaded with
 * UploadClickConversions – with the contact's gclid/gbraid/wbraid and, for enhanced conversions for leads, SHA-256 hashes of
 * e-mail and phone. Nothing leaves without the contact's marketing consent (consent ledger, channel "Tracking", purpose
 * "Marketing"), checked when the event happens and again right before the upload. Partial failures are handled per row,
 * whole-request failures retry with backoff, "Prüflauf" sends with validate_only. Uses the Google Ads connection of the ads
 * manager (developer token, OAuth, customer id, login customer id – sealed in ads_accounts). Docs: docs/ads-manager.md.
 */

const BACKOFF_MS = [300_000, 1_800_000, 7_200_000, 21_600_000, 43_200_000];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const KEEP_DAYS = 180;

export const adsConversionsModule: Module = {
  name: 'ads-conversions',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_gconv_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL DEFAULT '{}',
        last_run_at TEXT, last_error TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
      );
      CREATE TABLE ads_gconv_queue (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, event TEXT NOT NULL, order_id TEXT NOT NULL,
        contact_id TEXT REFERENCES contacts(id) ON DELETE CASCADE, conversion_action TEXT NOT NULL, value REAL, currency TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL, click_kind TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, sent_at TEXT,
        UNIQUE(location_id, order_id, conversion_action)
      );
      CREATE INDEX ads_gconv_queue_due ON ads_gconv_queue(status, next_at);
      CREATE INDEX ads_gconv_queue_location ON ads_gconv_queue(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    const settingsOf = (loc: string): { enabled: boolean; config: GConvConfig; row: any } | undefined => {
      const row = db.get('SELECT * FROM ads_gconv_settings WHERE location_id = ?', loc);
      if (!row) return undefined;
      let cfg: Partial<GConvConfig> = {};
      try {
        cfg = JSON.parse(row.config || '{}');
      } catch {
        cfg = {};
      }
      return { enabled: !!row.enabled, config: cleanConfig({}, cfg), row };
    };
    const conn = (loc: string) => loadConnection(app, loc, 'google');
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';

    /** Marketing consent of the contact in the ledger (channel "Tracking", purpose "Marketing"); no consent module = no consent. */
    const consentOk = (loc: string, contactId: string): boolean => {
      try {
        const st = app.services.consent?.status?.(loc, contactId);
        return st?.tracking?.purposes?.marketing?.status === 'confirmed';
      } catch {
        return false;
      }
    };

    /** Queues the conversion (or records it as blocked) and uploads right away; the event waits for it, the tick retries. */
    async function enqueue(loc: string, ev: GEvent, o: { orderId: string; contactId: string; value?: number; currency?: string; at?: string }): Promise<void> {
      const s = settingsOf(loc);
      const cfg = s?.config.events[ev];
      if (!s?.enabled || !cfg?.enabled || !cfg.action) return;
      const t = now();
      const allowed = consentOk(loc, o.contactId);
      db.run(
        `INSERT INTO ads_gconv_queue (id, location_id, event, order_id, contact_id, conversion_action, value, currency, occurred_at, status, next_at, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(location_id, order_id, conversion_action) DO NOTHING`,
        id(), loc, ev, o.orderId.slice(0, 64), o.contactId, cfg.action, o.value ?? null, (o.currency || s.config.currency || 'EUR').toUpperCase(), o.at ?? t,
        allowed ? 'pending' : 'blocked', t, allowed ? '' : 'Keine Einwilligung (Marketing) – nicht hochgeladen', t,
      );
      if (allowed) await run(loc).catch((e) => console.warn('[ads-conversions]', loc, (e as Error).message));
    }

    type Row = { id: string; location_id: string; event: string; order_id: string; contact_id: string | null; conversion_action: string; value: number | null; currency: string; occurred_at: string; attempts: number; status: string };
    type Prepared = { row: Row; conv: Record<string, any>; click: string };

    /** Builds the upload for the rows; rows that may not or cannot go are settled here (blocked / skipped). */
    function prepare(loc: string, rows: Row[], cfg: GConvConfig, settle: boolean): Prepared[] {
      const out: Prepared[] = [];
      const mark = (r: Row, status: string, error: string) => settle && db.run('UPDATE ads_gconv_queue SET status = ?, error = ?, next_at = ? WHERE id = ?', status, error, now(), r.id);
      for (const r of rows) {
        const c = r.contact_id ? getContact(app, loc, r.contact_id) : undefined;
        if (!c) {
          mark(r, 'skipped', 'Kontakt gibt es nicht mehr');
          continue;
        }
        if (!consentOk(loc, c.id)) {
          mark(r, 'blocked', 'Keine Einwilligung (Marketing) – nicht hochgeladen');
          continue;
        }
        const touches: TouchRow[] = app.services.attribution?.touchesOf?.(loc, c.id) ?? [];
        const click = googleClick(touches);
        const identifiers = cfg.enhanced_leads ? userIdentifiers(c) : [];
        if (!click && !identifiers.length) {
          mark(r, 'skipped', cfg.enhanced_leads ? 'Keine Google-Klick-ID und weder E-Mail noch Telefon' : 'Keine Google-Klick-ID (gclid/gbraid/wbraid) in den letzten 90 Tagen');
          continue;
        }
        const at = new Date(r.occurred_at);
        if (click && at.getTime() < Date.parse(click.at)) {
          mark(r, 'skipped', 'Die Conversion liegt vor dem Klick');
          continue;
        }
        out.push({ row: r, click: click?.kind ?? '', conv: clickConversion({ action: r.conversion_action, orderId: r.order_id, at, timeZone: tzOf(loc), value: r.value ?? undefined, currency: r.currency, click, identifiers }) });
      }
      return out;
    }

    const busy = new Set<string>();
    /** Uploads the due rows of a sub-account, batch by batch (rows queued meanwhile go along); one run per sub-account at a time. */
    async function run(loc: string): Promise<{ sent: number; failed: number; retry: number; skipped: number }> {
      const res = { sent: 0, failed: 0, retry: 0, skipped: 0 };
      const s = settingsOf(loc);
      if (!s?.enabled || busy.has(loc)) return res;
      busy.add(loc);
      try {
        for (let i = 0; i < 5; i++) {
          const r = await batch(loc, s.config);
          for (const k of Object.keys(res) as (keyof typeof res)[]) res[k] += r?.[k] ?? 0;
          if (!r || r.down) break;
        }
        return res;
      } finally {
        busy.delete(loc);
      }
    }

    /** One batch: the due rows, settled per row from the partial-failure answer; undefined when there was nothing (more) to do. */
    async function batch(loc: string, cfg: GConvConfig): Promise<{ sent: number; failed: number; retry: number; skipped: number; down?: boolean } | undefined> {
      const res = { sent: 0, failed: 0, retry: 0, skipped: 0, down: false };
      const rows = db.all<Row>(`SELECT * FROM ads_gconv_queue WHERE location_id = ? AND status IN ('pending', 'retry') AND next_at <= ? ORDER BY created_at, rowid LIMIT ?`, loc, now(), BATCH);
      if (!rows.length) return undefined;
      const c = conn(loc);
      if (!googleReady(app, c)) {
        db.run('UPDATE ads_gconv_settings SET last_error = ?, last_run_at = ? WHERE location_id = ?', 'Google Ads ist nicht verbunden (Anzeigen → Verbindungen)', now(), loc);
        return undefined;
      }
      const prepared = prepare(loc, rows, cfg, true);
      res.skipped = rows.length - prepared.length;
      if (!prepared.length) return res;
      const t = now();
      let resp: any;
      try {
        const api = googleApi(fetcherOf(app), await googleAuth(app, c));
        resp = await uploadClickConversions(api, prepared.map((p) => p.conv), false);
      } catch (e) {
        const msg = (e as Error).message.slice(0, 500);
        for (const p of prepared) {
          const attempts = p.row.attempts + 1;
          const wait = attempts >= MAX_ATTEMPTS ? null : BACKOFF_MS[attempts - 1];
          db.run('UPDATE ads_gconv_queue SET status = ?, attempts = ?, next_at = ?, error = ?, click_kind = ? WHERE id = ?', wait === null ? 'failed' : 'retry', attempts, wait === null ? t : new Date(Date.now() + wait).toISOString(), msg, p.click, p.row.id);
          if (wait === null) res.failed++;
          else res.retry++;
        }
        db.run('UPDATE ads_gconv_settings SET last_error = ?, last_run_at = ? WHERE location_id = ?', msg, t, loc);
        return { ...res, down: true };
      }
      splitResults(resp, prepared.length).forEach((r, i) => {
        const p = prepared[i];
        const attempts = p.row.attempts + 1;
        if (r.ok) {
          db.run('UPDATE ads_gconv_queue SET status = ?, attempts = ?, error = ?, sent_at = ?, click_kind = ? WHERE id = ?', r.duplicate ? 'duplicate' : 'sent', attempts, r.duplicate ? r.message : '', t, p.click, p.row.id);
          res.sent++;
          return;
        }
        const wait = r.retry && attempts < MAX_ATTEMPTS ? BACKOFF_MS[attempts - 1] : null;
        db.run('UPDATE ads_gconv_queue SET status = ?, attempts = ?, next_at = ?, error = ?, click_kind = ? WHERE id = ?', wait === null ? 'failed' : 'retry', attempts, wait === null ? t : new Date(Date.now() + wait).toISOString(), `${r.code ? `${r.code}: ` : ''}${r.message}`.slice(0, 500), p.click, p.row.id);
        if (wait === null) res.failed++;
        else res.retry++;
      });
      db.run(`UPDATE ads_gconv_settings SET last_error = '', last_run_at = ? WHERE location_id = ?`, t, loc);
      return res;
    }
    app.services.adsGoogleConversions = { enqueue, run };

    // --- the CRM events ------------------------------------------------------------------------------------------------------
    app.events.on('opportunity.status_changed', async (e) => {
      const o = e.data?.opportunity;
      if (e.data?.status !== 'won' || !o?.id || !o.contact_id) return;
      await enqueue(e.locationId, 'deal_won', { orderId: `deal_${o.id}`, contactId: o.contact_id, value: Number(o.value) || 0, currency: o.currency, at: e.at });
    });
    app.events.on('form.submitted', async (e) => {
      const d = e.data ?? {};
      if (!d.contactId) return;
      const cfg = settingsOf(e.locationId)?.config.events.form_submitted;
      if (cfg?.form_ids.length && !cfg.form_ids.includes(String(d.formId ?? ''))) return;
      await enqueue(e.locationId, 'form_submitted', { orderId: `form_${d.submission?.id ?? `${d.formId}_${d.contactId}`}`, contactId: d.contactId, value: cfg?.value || undefined, at: e.at });
    });
    app.events.on('appointment.booked', async (e) => {
      const a = e.data?.appointment;
      if (!a?.id || !e.data?.contactId) return;
      await enqueue(e.locationId, 'booking', { orderId: `booking_${a.id}`, contactId: e.data.contactId, value: settingsOf(e.locationId)?.config.events.booking.value || undefined, at: e.at });
    });
    app.events.on('invoice.paid', async (e) => {
      const inv = e.data?.invoice;
      if (!inv?.id || inv.kind !== 'invoice' || !inv.contact_id) return;
      await enqueue(e.locationId, 'invoice_paid', { orderId: `invoice_${inv.id}`, contactId: inv.contact_id, value: Number(inv.total_cents) / 100, currency: inv.currency, at: e.at });
    });

    let ticking = false;
    app.onTick(async () => {
      if (ticking) return;
      ticking = true;
      try {
        for (const d of db.all<{ location_id: string }>(`SELECT DISTINCT location_id FROM ads_gconv_queue WHERE status IN ('pending', 'retry') AND next_at <= ? LIMIT 50`, now())) {
          await run(d.location_id).catch((e) => console.warn('[ads-conversions]', d.location_id, (e as Error).message));
        }
        db.run(`DELETE FROM ads_gconv_queue WHERE created_at < ? AND status NOT IN ('pending', 'retry')`, new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
      } finally {
        ticking = false;
      }
    });

    // --- routes ---------------------------------------------------------------------------------------------------------------
    const view = (loc: string) => {
      const s = settingsOf(loc);
      const c = conn(loc);
      const g = googleCreds(app, c);
      const counts = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM ads_gconv_queue WHERE location_id = ? GROUP BY status', loc).map((r) => [r.status, r.n]));
      return {
        enabled: s?.enabled ?? false,
        config: s?.config ?? DEFAULT_GCONV,
        events: G_EVENTS.map((k) => ({ key: k, label: G_EVENT_LABEL[k] })),
        google: { connected: googleReady(app, c), customer_id: g.customerId, login_customer_id: g.loginCustomerId, last_error: c?.last_error ?? null },
        consent_module: !!app.services.consent?.status,
        last_run_at: s?.row.last_run_at ?? null,
        last_error: s?.row.last_error ?? '',
        counts,
      };
    };

    router.get('/api/ads/conversions', 'location', (ctx) => view(ctx.locationId));
    router.put('/api/ads/conversions', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const cur = settingsOf(ctx.locationId);
      let config: GConvConfig;
      try {
        config = cleanConfig(b.config ?? b, cur?.config ?? {}, googleCreds(app, conn(ctx.locationId)).customerId);
      } catch (e) {
        throw bad((e as Error).message);
      }
      const enabled = b.enabled === undefined ? (cur?.enabled ?? false) : !!b.enabled;
      if (enabled && !G_EVENTS.some((k) => config.events[k].enabled)) throw bad('Mindestens ein Ereignis mit Conversion-Aktion einschalten');
      db.run(
        `INSERT INTO ads_gconv_settings (location_id, enabled, config, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at`,
        ctx.locationId, enabled ? 1 : 0, JSON.stringify(config), now(),
      );
      return view(ctx.locationId);
    });

    router.get('/api/ads/conversions/log', 'location', (ctx) =>
      db.all(
        `SELECT q.id, q.event, q.order_id, q.contact_id, q.status, q.error, q.attempts, q.value, q.currency, q.click_kind, q.occurred_at, q.created_at, q.sent_at, q.next_at,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS contact_name
         FROM ads_gconv_queue q LEFT JOIN contacts c ON c.id = q.contact_id AND c.location_id = q.location_id
         WHERE q.location_id = ? ORDER BY q.created_at DESC, q.rowid DESC LIMIT ?`,
        ctx.locationId, clampLimit(ctx.query.get('limit'), 100, 500),
      ),
    );

    router.post('/api/ads/conversions/run', 'location', async (ctx) => {
      if (!settingsOf(ctx.locationId)?.enabled) throw new HttpError(409, 'Offline-Conversions sind aus');
      return run(ctx.locationId);
    });

    router.post('/api/ads/conversions/:id/retry', 'location', (ctx) => {
      const r = db.get('SELECT * FROM ads_gconv_queue WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Eintrag nicht gefunden');
      if (['sent', 'duplicate'].includes(r.status)) throw new HttpError(409, 'Schon hochgeladen');
      db.run(`UPDATE ads_gconv_queue SET status = 'pending', attempts = 0, next_at = ?, error = '' WHERE id = ?`, now(), r.id);
      void run(ctx.locationId).catch(() => undefined);
      return { ok: true };
    });

    /** Dry run: the next queued conversions (or a sample) go to Google with validate_only – nothing is stored, nothing changes here. */
    router.post('/api/ads/conversions/validate', 'location', async (ctx: Ctx) => {
      const s = settingsOf(ctx.locationId);
      const c = conn(ctx.locationId);
      if (!googleReady(app, c)) throw new HttpError(409, 'Google Ads ist nicht verbunden (Anzeigen → Verbindungen)');
      const cfg = s?.config ?? DEFAULT_GCONV;
      const rows = db.all<Row>(`SELECT * FROM ads_gconv_queue WHERE location_id = ? AND status IN ('pending', 'retry', 'failed') ORDER BY created_at DESC LIMIT 20`, ctx.locationId);
      let prepared = prepare(ctx.locationId, rows, cfg, false).map((p) => ({ order_id: p.row.order_id, event: p.row.event, conv: p.conv }));
      let sample = false;
      if (!prepared.length) {
        const ev = G_EVENTS.find((k) => cfg.events[k].action);
        if (!ev) throw bad('Erst eine Conversion-Aktion eintragen');
        sample = true;
        prepared = [{ order_id: 'gohigh_test', event: ev, conv: clickConversion({ action: cfg.events[ev].action, orderId: `gohigh_test_${Date.now()}`, at: new Date(), timeZone: tzOf(ctx.locationId), value: cfg.events[ev].value || 1, currency: cfg.currency, click: null, identifiers: userIdentifiers({ email: 'test@example.com' }) }) }];
      }
      try {
        const api = googleApi(fetcherOf(app), await googleAuth(app, c));
        const resp = await uploadClickConversions(api, prepared.map((p) => p.conv), true);
        const results = splitResults(resp, prepared.length).map((r, i) => ({ order_id: prepared[i].order_id, event: prepared[i].event, ok: r.ok, code: r.code, message: r.message }));
        return { ok: results.every((r) => r.ok), sample, results };
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    });
  },
};
