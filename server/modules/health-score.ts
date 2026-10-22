import type { Module } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { bad, notFound } from '../core/http.js';
import { sliceTimer } from '../core/perf.js';
import { now } from '../core/util.js';
import { getContact } from '../services/contacts.js';
import { overdueBefore } from '../services/invoice-model.js';
import { HEALTH_SIGNALS, SIGNAL_LABELS, computeHealth, healthDropped, type Band, type HealthInput } from '../services/health-score.js';
import { SLA_BREACHED_SQL, loadHelpdeskSettings, ticketOut } from '../services/tickets.js';

/**
 * Customer health score per contact (0–100, green/yellow/red) from weighted signals configured per
 * sub-account. Recomputed when something relevant happens and in the background; shown on the
 * contact list (column + filter via app.services.contactFilters) and the contact page. A worse
 * colour or a big drop fires health_score.dropped ("Health-Score gesunken").
 */

const TRIGGER = 'health_score.dropped';
const RECOMPUTE_ON = ['ticket.created', 'ticket.status_changed', 'sla.breached', 'csat.received', 'nps.received', 'invoice.paid', 'opportunity.created', 'opportunity.status_changed', 'message.inbound', 'email.opened', 'email.clicked'];
const STALE_MS = 12 * 36e5;
const PER_TICK = 200;

export const healthScoreModule: Module = {
  name: 'health-score',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE health_scores (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        score INTEGER NOT NULL, band TEXT NOT NULL, signals TEXT NOT NULL DEFAULT '{}', inputs TEXT NOT NULL DEFAULT '{}',
        previous_score INTEGER, computed_at TEXT NOT NULL
      );
      CREATE INDEX health_scores_loc ON health_scores(location_id, band);
      `,
    ],
    [
      '002-background-cursor',
      `
      -- The background job walks the contacts by rowid (cursor below) and refreshes the stalest scores by date.
      CREATE INDEX health_scores_computed ON health_scores(computed_at);
      CREATE TABLE health_sync (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), TRIGGER];

    const safe = <T>(fn: () => T, fallback: T): T => {
      try {
        return fn();
      } catch {
        return fallback;
      }
    };

    /** The raw facts behind the signals for one contact. */
    const inputsOf = (loc: string, contactId: string): HealthInput | null => {
      const c = db.get('SELECT id, last_activity_at, created_at FROM contacts WHERE id = ? AND location_id = ?', contactId, loc);
      if (!c) return null;
      const at = now();
      const breached = SLA_BREACHED_SQL.replace(/@now/g, '?');
      const nBreach = (SLA_BREACHED_SQL.match(/@now/g) ?? []).length;
      const t = db.get(
        `SELECT COUNT(*) AS open, SUM(CASE WHEN ${breached} THEN 1 ELSE 0 END) AS overdue FROM tickets t
         WHERE t.location_id = ? AND t.contact_id = ? AND t.status_kind IN ('new','open','waiting') AND t.merged_into IS NULL`,
        ...Array(nBreach).fill(at),
        loc,
        contactId,
      );
      const csat = db.get('SELECT csat_score FROM tickets WHERE location_id = ? AND contact_id = ? AND csat_score IS NOT NULL ORDER BY csat_at DESC LIMIT 1', loc, contactId);
      const nps = safe(() => db.get('SELECT score FROM nps_responses WHERE location_id = ? AND contact_id = ? ORDER BY updated_at DESC LIMIT 1', loc, contactId), undefined);
      const last = c.last_activity_at || c.created_at;
      const invoices = safe(() => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invoices WHERE location_id = ? AND contact_id = ? AND kind = 'invoice' AND status = 'sent' AND total_cents - paid_cents - credited_cents - deducted_cents > 0 AND due_at IS NOT NULL AND due_at < ?`, loc, contactId, overdueBefore(app.location(loc)?.timezone || 'Europe/Berlin'))!.n, 0);
      const yearAgo = new Date(Date.now() - 365 * 864e5).toISOString();
      const deals = safe(() => db.all(`SELECT status FROM opportunities WHERE location_id = ? AND contact_id = ? AND updated_at >= ?`, loc, contactId, yearAgo), [] as any[]);
      const dealStatus = deals.some((d) => d.status === 'won') ? 'won' : deals.some((d) => d.status === 'open') ? 'open' : deals.some((d) => d.status === 'lost' || d.status === 'abandoned') ? 'lost' : null;
      const since = new Date(Date.now() - 90 * 864e5).toISOString();
      const mail = safe(
        () => db.get(`SELECT COUNT(*) AS sent, SUM(CASE WHEN opened_at IS NOT NULL OR clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS engaged FROM messages WHERE location_id = ? AND contact_id = ? AND channel = 'email' AND direction = 'out' AND status IN ('sent','delivered') AND created_at >= ?`, loc, contactId, since),
        { sent: 0, engaged: 0 } as any,
      );
      return {
        openTickets: t?.open ?? 0,
        overdueTickets: t?.overdue ?? 0,
        lastCsat: csat?.csat_score ?? null,
        lastNps: nps?.score ?? null,
        daysSinceActivity: last ? Math.max(0, Math.floor((Date.now() - Date.parse(last)) / 864e5)) : null,
        overdueInvoices: invoices,
        dealStatus,
        emailsSent: mail?.sent ?? 0,
        emailsEngaged: mail?.engaged ?? 0,
      };
    };

    /** Recomputes and stores one contact's score; fires health_score.dropped on a drop. */
    const compute = (loc: string, contactId: string) => {
      const cfg = loadHelpdeskSettings(app, loc).health;
      const input = inputsOf(loc, contactId);
      if (!input) return null;
      const r = computeHealth(input, cfg);
      const prev = db.get<{ score: number; band: Band }>('SELECT score, band FROM health_scores WHERE contact_id = ?', contactId);
      db.run(
        `INSERT INTO health_scores (contact_id, location_id, score, band, signals, inputs, previous_score, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET score = excluded.score, band = excluded.band, signals = excluded.signals, inputs = excluded.inputs,
           previous_score = CASE WHEN health_scores.score != excluded.score THEN health_scores.score ELSE health_scores.previous_score END, computed_at = excluded.computed_at`,
        contactId,
        loc,
        r.score,
        r.band,
        JSON.stringify(r.signals),
        JSON.stringify(input),
        prev?.score ?? null,
        now(),
      );
      if (cfg.enabled && healthDropped(prev, r, cfg)) {
        app.events.emit(loc, TRIGGER, { contactId, score: r.score, band: r.band, previousScore: prev!.score, previousBand: prev!.band });
      }
      return { ...r, input, previous: prev ?? null };
    };
    app.services.healthCompute = compute;

    for (const type of RECOMPUTE_ON) {
      app.events.on(type, (e) => {
        const cid = e.data.contactId;
        if (!cid || !loadHelpdeskSettings(app, e.locationId).health.enabled) return;
        compute(e.locationId, cid);
      });
    }

    /**
     * Background refresh, a few hundred contacts per tick and never longer than ~40 ms at a time:
     * 1. contacts not seen yet, in rowid order from a stored cursor (no scan of the whole table per tick);
     *    the cursor starts over when the set of sub-accounts that switched scores off changes, so a
     *    sub-account that is switched on again is filled in;
     * 2. then the stalest scores (older than 12 h).
     */
    const syncValue = (key: string) => db.get<{ value: string }>('SELECT value FROM health_sync WHERE key = ?', key)?.value;
    const setSync = (key: string, value: string) => db.run('INSERT INTO health_sync (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    app.onTick(async () => {
      // Health scores are on unless a sub-account switched them off (helpdesk settings).
      const off = new Set(
        db
          .all('SELECT location_id FROM helpdesk_settings')
          .map((r) => r.location_id as string)
          .filter((l) => !loadHelpdeskSettings(app, l).health.enabled),
      );
      const stamp = [...off].sort().join(',');
      if (stamp !== (syncValue('disabled') ?? '')) {
        setSync('disabled', stamp);
        setSync('cursor', '0');
      }
      const pause = sliceTimer(40);
      let budget = PER_TICK;
      // 1. new contacts
      let cursor = Number(syncValue('cursor') ?? 0);
      // Contacts were deleted from the end of the table (their rowids get reused): start over.
      if (cursor > Number(db.get('SELECT MAX(rowid) AS m FROM contacts')?.m ?? 0)) cursor = 0;
      const rows = db.all('SELECT rowid AS rid, id, location_id FROM contacts WHERE rowid > ? ORDER BY rowid LIMIT ?', cursor, PER_TICK);
      for (const r of rows) {
        if (!off.has(r.location_id) && !db.get('SELECT 1 FROM health_scores WHERE contact_id = ?', r.id)) {
          compute(r.location_id, r.id);
          budget--;
          await pause();
        }
      }
      if (rows.length) setSync('cursor', String(rows[rows.length - 1].rid));
      // 2. stale scores
      if (budget <= 0) return;
      const stale = new Date(Date.now() - STALE_MS).toISOString();
      for (const r of db.all('SELECT contact_id AS id, location_id FROM health_scores WHERE computed_at < ? ORDER BY computed_at LIMIT ?', stale, budget)) {
        if (!off.has(r.location_id)) compute(r.location_id, r.id);
        await pause();
      }
    });

    // --- contact list: column + filter ---------------------------------------------------------
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const v = String(f?.query?.get?.('health') ?? f?.extra?.health ?? f?.health ?? '').trim();
        if (!v) return undefined;
        if (v === 'none') return { sql: 'NOT EXISTS (SELECT 1 FROM health_scores h WHERE h.contact_id = contacts.id)', params: [] };
        if (!['green', 'yellow', 'red'].includes(v)) return undefined;
        return { sql: 'EXISTS (SELECT 1 FROM health_scores h WHERE h.contact_id = contacts.id AND h.band = ?)', params: [v] };
      },
    ];

    router.get('/api/health/scores', 'location', (ctx) => {
      const ids = String(ctx.query.get('ids') ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
      const out: Record<string, { score: number; band: string }> = {};
      if (!ids.length) return out;
      const rows = db.all(`SELECT contact_id, score, band FROM health_scores WHERE location_id = ? AND contact_id IN (${ids.map(() => '?').join(',')})`, ctx.locationId, ...ids);
      for (const r of rows) out[r.contact_id] = { score: r.score, band: r.band };
      // Not computed yet (new contacts): compute now so the column is never empty.
      if (loadHelpdeskSettings(app, ctx.locationId).health.enabled) {
        for (const cid of ids.filter((x) => !out[x])) {
          const r = compute(ctx.locationId, cid);
          if (r) out[cid] = { score: r.score, band: r.band };
        }
      }
      return out;
    });

    router.get('/api/health/contacts/:id', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.id)) throw notFound('Kontakt nicht gefunden');
      const cfg = loadHelpdeskSettings(app, ctx.locationId).health;
      const r = compute(ctx.locationId, ctx.params.id)!;
      return { score: r.score, band: r.band, previous_score: r.previous?.score ?? null, enabled: cfg.enabled, signals: HEALTH_SIGNALS.map((k) => ({ key: k, label: SIGNAL_LABELS[k], score: r.signals[k], weight: cfg.weights[k] })), input: r.input };
    });

    router.post('/api/health/recompute', 'location', (ctx) => {
      if (!loadHelpdeskSettings(app, ctx.locationId).health.enabled) throw bad('Der Health-Score ist ausgeschaltet');
      const ids = db.all('SELECT id FROM contacts WHERE location_id = ? ORDER BY last_activity_at DESC LIMIT 5000', ctx.locationId);
      for (const r of ids) compute(ctx.locationId, r.id);
      return { count: ids.length };
    });

    router.get('/api/health/summary', 'location', (ctx) => {
      const rows = db.all('SELECT band, COUNT(*) AS n, AVG(score) AS avg FROM health_scores WHERE location_id = ? GROUP BY band', ctx.locationId);
      const by = Object.fromEntries(['green', 'yellow', 'red'].map((b) => [b, rows.find((r) => r.band === b)?.n ?? 0]));
      const total = rows.reduce((s, r) => s + r.n, 0);
      return { ...by, total, avg: total ? Math.round(rows.reduce((s, r) => s + r.avg * r.n, 0) / total) : null };
    });

    /** Everything "Service" for the contact page: health, tickets, CSAT and NPS answers. */
    router.get('/api/contacts/:id/service', 'location', (ctx) => {
      if (!getContact(app, ctx.locationId, ctx.params.id)) throw notFound('Kontakt nicht gefunden');
      const cfg = loadHelpdeskSettings(app, ctx.locationId).health;
      const h = cfg.enabled ? compute(ctx.locationId, ctx.params.id) : null;
      const tickets = db
        .all('SELECT * FROM tickets WHERE location_id = ? AND contact_id = ? AND merged_into IS NULL ORDER BY updated_at DESC LIMIT 10', ctx.locationId, ctx.params.id)
        .map((t) => ticketOut(app, parseJson(t, ['tags'])))
        .map(({ description: _d, ...t }) => t);
      return {
        health: h ? { score: h.score, band: h.band, previous_score: h.previous?.score ?? null, signals: HEALTH_SIGNALS.map((k) => ({ key: k, label: SIGNAL_LABELS[k], score: h.signals[k], weight: cfg.weights[k] })) } : null,
        tickets,
        open: tickets.filter((t) => ['new', 'open', 'waiting'].includes(t.status_kind)).length,
        surveys: app.services.surveysOfContact?.(ctx.locationId, ctx.params.id) ?? { csat: [], nps: [] },
      };
    });
  },
};
