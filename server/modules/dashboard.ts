import type { Module } from '../core/app.js';
import { num } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { paidRevenueSql } from '../services/invoice-model.js';
import { overdue } from '../services/mobile.js';
import { maskRow, resolve, scopeClause, type Resolved } from '../services/record-access.js';

export const dashboardModule: Module = {
  name: 'dashboard',
  register(app) {
    const { db, router } = app;

    // The numbers only change when something is written: computed once, served from memory until then (db.memo).
    router.get('/api/dashboard', 'location', (ctx) => {
      const days = Math.min(Math.max(num(ctx.query.get('days'), 30), 1), 365);
      // A person with a limited view (record-access rules) gets the numbers of their own records – kept apart per person.
      const access = resolve(app, ctx);
      return db.memo(`dashboard:${ctx.locationId}:${days}${access ? `:${access.userId}` : ''}`, 15_000, () => dashboard(ctx.locationId, days, access));
    });

    /** Total and new contacts in one pass over the sub-account's index range. */
    const contactCounts = (loc: string, since: string, sc = '', p: any[] = []) => {
      const r = db.get(`SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?), 0) AS fresh FROM contacts WHERE location_id = ?${sc}`, since, loc, ...p);
      return { total: Number(r?.total ?? 0), new: Number(r?.fresh ?? 0) };
    };

    const dashboard = (loc: string, days: number, access: Resolved | null = null) => {
      // " AND <clause>" snippets of the person's view for contacts, deals, tasks and conversations (empty for everyone else).
      const part = (e: 'contacts' | 'deals' | 'tasks' | 'conversations', alias: string) => {
        const c = scopeClause(access, e, alias);
        return { sql: c ? ` AND ${c.sql}` : '', params: c?.params ?? [] };
      };
      const cs = part('contacts', 'contacts');
      const os = part('deals', 'opportunities');
      const ts = part('tasks', 'tasks');
      const vs = part('conversations', 'v');
      const since = new Date(Date.now() - days * 864e5).toISOString();
      // "Today" and the day of a lead are the sub-account's, not UTC's: after midnight in Berlin it is already tomorrow.
      const tz = app.location(loc)?.timezone || 'Europe/Berlin';
      const nowIso = new Date().toISOString();
      const today = ymdInTz(new Date(nowIso), tz);
      // Tasks due on a date (no time) are overdue the day after, timed ones at their time – the same rule as the app's task lists.
      // The range on due_at only narrows what the index has to read: every overdue task lies inside it.
      const overdueBefore = nowIso > `${today}T00:00:00.000Z` ? nowIso : `${today}T00:00:00.000Z`;
      const one = (sql: string, ...p: any[]) => Number(Object.values(db.get(sql, ...p) ?? { n: 0 })[0] ?? 0);

      const pipelines = db.all('SELECT id, name, stages FROM pipelines WHERE location_id = ?', loc).map((p) => {
        const stages = JSON.parse(p.stages);
        const counts = db.all(`SELECT stage_id, COUNT(*) n, COALESCE(SUM(value),0) v FROM opportunities WHERE pipeline_id = ? AND status = 'open'${os.sql} GROUP BY stage_id`, p.id, ...os.params);
        return { id: p.id, name: p.name, stages: stages.map((s: any) => ({ ...s, count: counts.find((c) => c.stage_id === s.id)?.n ?? 0, value: counts.find((c) => c.stage_id === s.id)?.v ?? 0 })) };
      });

      // Counted per minute in SQL (bulk imports collapse), then put on the local day – exact across DST too.
      const perDay = new Map<string, number>();
      for (const r of db.all<{ m: string; n: number }>(`SELECT substr(created_at, 1, 16) AS m, COUNT(*) AS n FROM contacts WHERE location_id = ? AND created_at >= ?${cs.sql} GROUP BY m`, loc, since, ...cs.params)) {
        const at = Date.parse(`${r.m}:00Z`);
        if (!Number.isFinite(at)) continue;
        const day = ymdInTz(new Date(at), tz);
        perDay.set(day, (perDay.get(day) ?? 0) + Number(r.n));
      }
      const leadsPerDay = [...perDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, n]) => ({ day, n }));

      // Money in different currencies is never added up (there are no exchange rates): per currency, the sub-account's main
      // currency (the one most of its invoices are in) first. `paid`/`outstanding` keep the main currency's amounts for older clients.
      const cur = (c: unknown) => (typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : 'EUR');
      const byCurrency = new Map<string, { currency: string; paid: number; outstanding: number }>();
      const add = (c: unknown, k: 'paid' | 'outstanding', v: unknown) => {
        const key = cur(c);
        const row = byCurrency.get(key) ?? { currency: key, paid: 0, outstanding: 0 };
        row[k] += Number(v) || 0;
        byCurrency.set(key, row);
      };
      for (const r of db.all(`SELECT currency, COALESCE(SUM(${paidRevenueSql()}),0) AS v FROM invoices WHERE location_id = ? AND status = 'paid' AND paid_at >= ? GROUP BY currency`, loc, since)) add(r.currency, 'paid', r.v);
      for (const r of db.all(`SELECT currency, COALESCE(SUM(MAX(0, total_cents - paid_cents - credited_cents - deducted_cents)),0) AS v FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'sent' GROUP BY currency`, loc)) add(r.currency, 'outstanding', r.v);
      const main = cur(db.get(`SELECT currency FROM invoices WHERE location_id = ? AND kind = 'invoice' GROUP BY currency ORDER BY COUNT(*) DESC, currency = 'EUR' DESC, currency LIMIT 1`, loc)?.currency);
      const revenueByCurrency = [...byCurrency.values()].filter((r) => r.paid || r.outstanding).sort((a, b) => (a.currency === main ? -1 : b.currency === main ? 1 : a.currency < b.currency ? -1 : 1));
      const mainRow = byCurrency.get(main);
      const sources = db.all(`SELECT COALESCE(NULLIF(source,''),'unbekannt') AS source, COUNT(*) n FROM contacts WHERE location_id = ? AND created_at >= ?${cs.sql} GROUP BY 1 ORDER BY n DESC LIMIT 10`, loc, since, ...cs.params);

      return {
        days,
        today,
        contacts: contactCounts(loc, since, cs.sql, cs.params),
        // won/lost count when the deal was closed (`closed_at`, kept by modules/reports.ts) – a later edit of an old deal must not count again
        opportunities: {
          open: one(`SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'open'${os.sql}`, loc, ...os.params),
          openValue: access?.hidden.deals.has('value') ? 0 : one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'open'${os.sql}`, loc, ...os.params),
          won: one(`SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'won' AND COALESCE(closed_at, updated_at) >= ?${os.sql}`, loc, since, ...os.params),
          wonValue: access?.hidden.deals.has('value') ? 0 : one(`SELECT COALESCE(SUM(value),0) FROM opportunities WHERE location_id = ? AND status = 'won' AND COALESCE(closed_at, updated_at) >= ?${os.sql}`, loc, since, ...os.params),
          lost: one(`SELECT COUNT(*) FROM opportunities WHERE location_id = ? AND status = 'lost' AND COALESCE(closed_at, updated_at) >= ?${os.sql}`, loc, since, ...os.params),
        },
        appointments: {
          upcoming: one(`SELECT COUNT(*) FROM appointments WHERE location_id = ? AND status = 'confirmed' AND start_at >= ?`, loc, new Date().toISOString()),
          booked: one(`SELECT COUNT(*) FROM appointments WHERE location_id = ? AND created_at >= ? AND status != 'blocked'`, loc, since),
          showed: one(`SELECT COUNT(*) FROM appointments WHERE location_id = ? AND status = 'showed' AND start_at >= ?`, loc, since),
          noshow: one(`SELECT COUNT(*) FROM appointments WHERE location_id = ? AND status = 'noshow' AND start_at >= ?`, loc, since),
          next: db.all(
            `SELECT a.id, a.title, a.start_at, c.first_name, c.last_name FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
             WHERE a.location_id = ? AND a.status = 'confirmed' AND a.start_at >= ? ORDER BY a.start_at LIMIT 5`,
            loc,
            new Date().toISOString(),
          ),
        },
        messages: {
          sent: one(`SELECT COUNT(*) FROM messages WHERE location_id = ? AND direction = 'out' AND created_at >= ?`, loc, since),
          received: one(`SELECT COUNT(*) FROM messages WHERE location_id = ? AND direction = 'in' AND created_at >= ?`, loc, since),
          unread: one(`SELECT COALESCE(SUM(unread),0) FROM conversations v WHERE v.location_id = ?${vs.sql}`, loc, ...vs.params),
        },
        forms: { submissions: one('SELECT COUNT(*) FROM form_submissions WHERE location_id = ? AND created_at >= ?', loc, since) },
        revenue: { currency: main, paid: mainRow?.paid ?? 0, outstanding: mainRow?.outstanding ?? 0, by_currency: revenueByCurrency },
        reviews: { average: db.get('SELECT ROUND(AVG(rating),1) a, COUNT(rating) n FROM review_requests WHERE location_id = ?', loc) },
        tasks: { open: one(`SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0${ts.sql}`, loc, ...ts.params), overdue: one(`SELECT COUNT(*) FROM tasks WHERE location_id = ? AND done = 0 AND due_at < ? AND ${overdue()}${ts.sql}`, loc, overdueBefore, today, nowIso, ...ts.params) },
        pipelines,
        leadsPerDay,
        sources,
      };
    };

    /** Global search across contacts, opportunities and pages for the top bar. */
    router.get('/api/search', 'location', (ctx) => {
      const q = `%${ctx.query.get('q') ?? ''}%`;
      if (q.length < 4) return { contacts: [], opportunities: [] };
      // Record-access rules: the search finds what the person may open, and shows fields as they may see them.
      const access = resolve(app, ctx);
      const cs = scopeClause(access, 'contacts', 'contacts');
      const os = scopeClause(access, 'deals', 'opportunities');
      return {
        contacts: db
          .all(
            `SELECT id, first_name, last_name, email, phone FROM contacts WHERE location_id = ? AND (first_name || ' ' || last_name || ' ' || email || ' ' || phone || ' ' || company) LIKE ?${cs ? ` AND ${cs.sql}` : ''} LIMIT 8`,
            ctx.locationId,
            q,
            ...(cs?.params ?? []),
          )
          .map((c) => maskRow(access, 'contacts', c)),
        opportunities: db
          .all(`SELECT id, name, pipeline_id, value FROM opportunities WHERE location_id = ? AND name LIKE ?${os ? ` AND ${os.sql}` : ''} LIMIT 5`, ctx.locationId, q, ...(os?.params ?? []))
          .map((o) => maskRow(access, 'deals', o)),
      };
    });
  },
};
