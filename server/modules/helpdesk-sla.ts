import type { Module } from '../core/app.js';
import { num } from '../core/http.js';
import { addDaysYmd, ymdInTz, zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { notifyTeam } from '../services/messaging.js';
import { PRIORITIES, raisePriority, validTz } from '../services/helpdesk.js';
import { SLA_BREACHED_SQL, SLA_WARNING_SQL, addTicketEvent, agentsOf, getTicketRow, loadHelpdeskSettings, ticketBrief, ticketPipelines, updateTicket } from '../services/tickets.js';

/**
 * SLA timers of the helpdesk: every scheduler tick checks running timers, writes "läuft bald ab" /
 * "überschritten" to the timeline, fires sla.warning / sla.breached (workflow triggers) and runs the
 * built-in escalation (notify the owner, raise the priority, hand to a team). Also the helpdesk
 * dashboard (open tickets, SLA compliance, response times, backlog trend, CSAT/NPS) and workload view.
 */

const TRIGGERS = ['sla.warning', 'sla.breached'];
const KIND_LABEL: Record<string, string> = { first_response: 'Erste Antwort', resolution: 'Lösung' };

export const helpdeskSlaModule: Module = {
  name: 'helpdesk-sla',
  register(app) {
    const { db, router } = app;
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...TRIGGERS];

    /** One pass over running timers; exported for tests via app.services.helpdeskSlaTick. */
    const tick = async (at = new Date()) => {
      const iso = at.toISOString();
      const rows = db.all(
        `SELECT * FROM tickets WHERE status_kind IN ('new','open','waiting') AND merged_into IS NULL AND (
           (first_response_at IS NULL AND first_response_warn_at <= ? AND sla_first_state = '') OR
           (first_response_at IS NULL AND first_response_due_at <= ? AND sla_first_state != 'breached') OR
           (sla_paused_at IS NULL AND resolution_warn_at <= ? AND sla_resolution_state = '') OR
           (sla_paused_at IS NULL AND resolution_due_at <= ? AND sla_resolution_state != 'breached')
         ) ORDER BY updated_at LIMIT 500`,
        iso,
        iso,
        iso,
        iso,
      );
      const out: { ticketId: string; kind: string; type: string }[] = [];
      for (const t of rows) {
        const changes: [kind: 'first_response' | 'resolution', type: 'warning' | 'breached', due: string][] = [];
        if (!t.first_response_at) {
          if (t.first_response_due_at && t.first_response_due_at <= iso && t.sla_first_state !== 'breached') changes.push(['first_response', 'breached', t.first_response_due_at]);
          else if (t.first_response_warn_at && t.first_response_warn_at <= iso && !t.sla_first_state) changes.push(['first_response', 'warning', t.first_response_due_at]);
        }
        if (!t.sla_paused_at) {
          if (t.resolution_due_at && t.resolution_due_at <= iso && t.sla_resolution_state !== 'breached') changes.push(['resolution', 'breached', t.resolution_due_at]);
          else if (t.resolution_warn_at && t.resolution_warn_at <= iso && !t.sla_resolution_state) changes.push(['resolution', 'warning', t.resolution_due_at]);
        }
        if (!changes.length) continue;
        const s = loadHelpdeskSettings(app, t.location_id);
        for (const [kind, type, due] of changes) {
          const col = kind === 'first_response' ? 'sla_first_state' : 'sla_resolution_state';
          // Claim the transition so a parallel tick can't fire it twice.
          if (!db.run(`UPDATE tickets SET ${col} = ? WHERE id = ? AND ${col} != ?${type === 'warning' ? ` AND ${col} = ''` : ''}`, type, t.id, type).changes) continue;
          const label = `${KIND_LABEL[kind]}: SLA ${type === 'warning' ? 'läuft bald ab' : 'überschritten'}`;
          addTicketEvent(app, t, type === 'warning' ? 'sla_warning' : 'sla_breached', { body: label, data: { kind, due } });
          const fresh = getTicketRow(app, t.location_id, t.id);
          app.events.emit(t.location_id, `sla.${type}`, { contactId: fresh.contact_id, ticketId: fresh.id, ticket: ticketBrief(app, fresh), slaKind: kind, dueAt: due });
          out.push({ ticketId: t.id, kind, type });
          if (type === 'warning' && fresh.owner_id) {
            void Promise.resolve(app.services.pushNotify?.({ userIds: [fresh.owner_id], kind: 'tasks', title: `SLA läuft bald ab: #${fresh.number}`, body: `${KIND_LABEL[kind]} – ${fresh.subject}`, url: `/app/tickets/${fresh.id}`, tag: `sla-${fresh.id}` })).catch(() => {});
          }
          if (type !== 'breached') continue;
          // Built-in escalation (more via workflows on sla.breached).
          if (s.sla.raise_priority_on_breach && fresh.priority !== 'dringend') {
            const p = raisePriority(fresh.priority);
            db.run('UPDATE tickets SET priority = ?, updated_at = ? WHERE id = ?', p, now(), fresh.id);
            addTicketEvent(app, fresh, 'priority', { body: `Priorität: ${fresh.priority} → ${p} (SLA überschritten)`, data: { from: fresh.priority, to: p, via: 'sla' } });
          }
          if (s.sla.breach_team_id && fresh.team_id !== s.sla.breach_team_id && db.get('SELECT 1 FROM helpdesk_teams WHERE id = ? AND location_id = ?', s.sla.breach_team_id, t.location_id)) {
            updateTicket(app, t.location_id, fresh.id, { team_id: s.sla.breach_team_id, owner_id: 'round_robin' }, { via: 'sla' });
          }
          const owner = fresh.owner_id ? db.get('SELECT id, email FROM users WHERE id = ?', fresh.owner_id) : undefined;
          if (s.sla.notify_owner) {
            const text = `${label}\n\n#${fresh.number} ${fresh.subject}\n${app.baseUrl()}/app/tickets/${fresh.id}`;
            if (owner?.email) await notifyTeam(app, t.location_id, `SLA überschritten: Ticket #${fresh.number}`, text, owner.email).catch(() => undefined);
            else await notifyTeam(app, t.location_id, `SLA überschritten: Ticket #${fresh.number}`, text).catch(() => undefined);
            void Promise.resolve(
              app.services.pushNotify?.({ ...(owner ? { userIds: [owner.id] } : { locationId: t.location_id }), kind: 'tasks', title: `SLA überschritten: #${fresh.number}`, body: fresh.subject, url: `/app/tickets/${fresh.id}`, tag: `sla-${fresh.id}`, urgency: 'high' }),
            ).catch(() => {});
          }
        }
      }
      return out;
    };
    app.services.helpdeskSlaTick = tick;
    app.onTick(() => tick().then(() => undefined));

    // --- dashboard -----------------------------------------------------------------------------------
    router.get('/api/helpdesk/dashboard', 'location', (ctx) => {
      const loc = ctx.locationId;
      const days = Math.min(365, Math.max(7, Math.round(num(ctx.query.get('days'), 30))));
      const tz = validTz(app.location(loc)?.timezone || 'Europe/Berlin');
      const today = ymdInTz(new Date(), tz);
      const startYmd = addDaysYmd(today, -(days - 1));
      const from = zonedToUtc(startYmd, '00:00', tz).toISOString();
      const at = now();
      const pipelines = ticketPipelines(app, loc);
      const stageName = new Map(pipelines.flatMap((p) => p.stages.map((s) => [`${p.id}:${s.id}`, s.name] as const)));
      const openRows = db.all(`SELECT pipeline_id, stage_id, priority, owner_id, COUNT(*) AS n FROM tickets WHERE location_id = ? AND status_kind IN ('new','open','waiting') AND merged_into IS NULL GROUP BY pipeline_id, stage_id, priority, owner_id`, loc);
      const byStatus = new Map<string, number>();
      const byPriority: Record<string, number> = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
      const byOwner = new Map<string, number>();
      let openTotal = 0;
      for (const r of openRows) {
        const nm = stageName.get(`${r.pipeline_id}:${r.stage_id}`) ?? r.stage_id;
        byStatus.set(nm, (byStatus.get(nm) ?? 0) + r.n);
        byPriority[r.priority] = (byPriority[r.priority] ?? 0) + r.n;
        byOwner.set(r.owner_id ?? '', (byOwner.get(r.owner_id ?? '') ?? 0) + r.n);
        openTotal += r.n;
      }
      const agents = new Map(agentsOf(app, loc).map((a) => [a.id, a.name]));
      const count = (sql: string, ...p: any[]) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM tickets t WHERE t.location_id = ? AND ${sql}`, loc, ...p)!.n;
      const sqlNow = (s: string) => s.replace(/@now/g, '?');
      const nowParams = (s: string) => (s.match(/@now/g) ?? []).map(() => at);
      const openSql = `t.status_kind IN ('new','open','waiting') AND t.merged_into IS NULL`;
      const breached = count(`${openSql} AND ${sqlNow(SLA_BREACHED_SQL)}`, ...nowParams(SLA_BREACHED_SQL));
      const warning = count(`${openSql} AND NOT ${sqlNow(SLA_BREACHED_SQL)} AND ${sqlNow(SLA_WARNING_SQL)}`, ...nowParams(SLA_BREACHED_SQL), ...nowParams(SLA_WARNING_SQL));

      const period = db.all(`SELECT created_at, first_response_at, first_response_due_at, resolved_at, resolution_due_at, sla_first_state, sla_resolution_state, csat_score FROM tickets WHERE location_id = ? AND merged_into IS NULL AND created_at >= ?`, loc, from);
      const minutes = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60000;
      const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
      const firstTimes = period.filter((r) => r.first_response_at).map((r) => minutes(r.created_at, r.first_response_at));
      const resolveTimes = period.filter((r) => r.resolved_at).map((r) => minutes(r.created_at, r.resolved_at));
      const compliance = (rows: any[], doneKey: string, dueKey: string, stateKey: string) => {
        let met = 0;
        let missed = 0;
        for (const r of rows) {
          if (!r[dueKey]) continue;
          if (r[doneKey]) r[doneKey] <= r[dueKey] && r[stateKey] !== 'breached' ? met++ : missed++;
          else if (r[dueKey] <= at || r[stateKey] === 'breached') missed++;
        }
        return { met, missed, pct: met + missed ? Math.round((met / (met + missed)) * 100) : null };
      };
      // Backlog per day: tickets open at the end of each local day.
      const life = db.all(`SELECT created_at, resolved_at FROM tickets WHERE location_id = ? AND merged_into IS NULL AND (resolved_at IS NULL OR resolved_at >= ?)`, loc, from);
      const trend = [] as { day: string; created: number; resolved: number; backlog: number }[];
      for (let i = 0; i < days; i++) {
        const day = addDaysYmd(startYmd, i);
        const start = zonedToUtc(day, '00:00', tz).toISOString();
        const end = zonedToUtc(addDaysYmd(day, 1), '00:00', tz).toISOString();
        trend.push({
          day,
          created: period.filter((r) => r.created_at >= start && r.created_at < end).length,
          resolved: life.filter((r) => r.resolved_at && r.resolved_at >= start && r.resolved_at < end).length,
          backlog: life.filter((r) => r.created_at < end && (!r.resolved_at || r.resolved_at >= end)).length,
        });
      }
      const csatRows = db.all(`SELECT csat_score FROM tickets WHERE location_id = ? AND csat_score IS NOT NULL AND csat_at >= ?`, loc, from);
      const dist = [1, 2, 3, 4, 5].map((s) => csatRows.filter((r) => r.csat_score === s).length);
      return {
        days,
        open_total: openTotal,
        unassigned: byOwner.get('') ?? 0,
        breached_open: breached,
        warning_open: warning,
        by_status: [...byStatus.entries()].map(([name, n]) => ({ name, n })),
        by_priority: byPriority,
        by_owner: [...byOwner.entries()].map(([oid, n]) => ({ owner_id: oid || null, name: oid ? (agents.get(oid) ?? 'Unbekannt') : 'Nicht zugewiesen', n })).sort((a, b) => b.n - a.n),
        created: period.length,
        resolved: period.filter((r) => r.resolved_at).length,
        sla: { first_response: compliance(period, 'first_response_at', 'first_response_due_at', 'sla_first_state'), resolution: compliance(period, 'resolved_at', 'resolution_due_at', 'sla_resolution_state') },
        avg_first_response_min: avg(firstTimes),
        avg_resolution_min: avg(resolveTimes),
        trend,
        csat: { count: csatRows.length, avg: csatRows.length ? Math.round((csatRows.reduce((s, r) => s + r.csat_score, 0) / csatRows.length) * 10) / 10 : null, distribution: dist, satisfied_pct: csatRows.length ? Math.round(((dist[3] + dist[4]) / csatRows.length) * 100) : null },
        nps: app.services.npsStats?.(loc, from) ?? null,
      };
    });

    /** Who has how much: open, overdue, urgent per person (and unassigned). */
    router.get('/api/helpdesk/workload', 'location', (ctx) => {
      const loc = ctx.locationId;
      const at = now();
      const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
      const breachedSql = SLA_BREACHED_SQL.replace(/@now/g, '?');
      const nBreach = (SLA_BREACHED_SQL.match(/@now/g) ?? []).length;
      const rows = db.all(
        `SELECT t.owner_id,
           SUM(CASE WHEN t.status_kind IN ('new','open','waiting') THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN t.status_kind = 'waiting' THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN t.status_kind IN ('new','open','waiting') AND t.priority IN ('hoch','dringend') THEN 1 ELSE 0 END) AS urgent,
           SUM(CASE WHEN t.status_kind IN ('new','open','waiting') AND ${breachedSql} THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN t.resolved_at >= ? THEN 1 ELSE 0 END) AS resolved_week
         FROM tickets t WHERE t.location_id = ? AND t.merged_into IS NULL GROUP BY t.owner_id`,
        ...Array(nBreach).fill(at),
        weekAgo,
        loc,
      );
      const byOwner = new Map(rows.map((r) => [r.owner_id ?? '', r]));
      const zero = { open: 0, waiting: 0, urgent: 0, overdue: 0, resolved_week: 0 };
      const teams = db.all('SELECT id, name, members FROM helpdesk_teams WHERE location_id = ?', loc);
      const people = agentsOf(app, loc).map((a) => {
        const r = byOwner.get(a.id) ?? zero;
        return { owner_id: a.id, name: a.name, email: a.email, teams: teams.filter((tm) => JSON.parse(tm.members || '[]').includes(a.id)).map((tm) => tm.name), open: r.open ?? 0, waiting: r.waiting ?? 0, urgent: r.urgent ?? 0, overdue: r.overdue ?? 0, resolved_week: r.resolved_week ?? 0 };
      });
      const u = byOwner.get('') ?? zero;
      return { people: people.sort((a, b) => b.open - a.open), unassigned: { open: u.open ?? 0, urgent: u.urgent ?? 0, overdue: u.overdue ?? 0 } };
    });
  },
};
