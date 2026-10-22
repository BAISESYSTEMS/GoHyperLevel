import type { Module } from '../core/app.js';
import { HttpError, bad, num, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { boardWidgets, type View, type WidgetCtx } from '../services/boards-widgets.js';
import { cleanCurrency } from '../services/opportunities.js';
import { METRICS, METRIC_LABEL, PERIODS, currentPeriod, pct, periodRange, periodStart, rank, shiftPeriod, standings, type Metric, type PeriodKind, type Standing } from '../services/quotas.js';
import { canConfigure, limits, mustConfigure, resolve } from '../services/record-access.js';
import { peopleOf } from '../services/team-people.js';
import type { Tool } from './mcp.js';

/**
 * Quoten und Rangliste (docs/sales.md): Ziele je Person und Team für Monat oder Quartal (gewonnener Umsatz oder gewonnene Deals),
 * Zielerreichung mit Zeitfortschritt und Pipeline, Rangliste, und zwei Widgets für die Living Boards. Die Rechenregeln stehen in
 * services/quotas.ts.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Schlüssel weglassen' } };
const WHEN = { period: { type: 'string', enum: [...PERIODS] }, start: { type: 'string', description: 'Erster Tag der Periode (JJJJ-MM-TT), Standard: laufende' }, metric: { type: 'string', enum: [...METRICS] } };
const qs = (a: Record<string, unknown>) => new URLSearchParams(Object.fromEntries(Object.entries(a).filter(([k, v]) => ['period', 'start', 'metric', 'scope'].includes(k) && v !== undefined && v !== '') as [string, string][])).toString();

const TOOLS: Tool[] = [
  {
    name: 'ghl_quota_list',
    title: 'Quoten und Zielerreichung',
    description: 'Quote, Erreichtes (gewonnener Umsatz oder gewonnene Deals), Erreichung in %, Zeitfortschritt, Pipeline und Rückstand je Person und Team für Monat oder Quartal. Nur lesen.',
    inputSchema: { type: 'object', properties: { ...LOC, ...WHEN }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/quotas?${qs(a)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_quota_set',
    title: 'Quote festlegen',
    description: 'Setzt Quoten für eine Periode: quotas = [{scope: user|team, subject_id: Nutzer- oder Team-ID, target: Zahl}]; target 0 oder leer entfernt die Quote. Admin-Recht nötig.',
    inputSchema: {
      type: 'object',
      properties: { ...LOC, ...WHEN, quotas: { type: 'array', items: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'team'] }, subject_id: { type: 'string' }, target: { type: 'number' } }, required: ['scope', 'subject_id'] } } },
      required: ['quotas'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('PUT', '/api/quotas', { location: a.location_id, body: { period: a.period, start: a.start, metric: a.metric, quotas: a.quotas } }),
  },
  {
    name: 'ghl_leaderboard',
    title: 'Vertriebs-Rangliste',
    description: 'Rangliste der Personen (scope=user) oder Teams (scope=team) nach gewonnenem Umsatz bzw. gewonnenen Deals in einer Periode, mit Quote und Erreichung. Nur lesen.',
    inputSchema: { type: 'object', properties: { ...LOC, ...WHEN, scope: { type: 'string', enum: ['user', 'team'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/leaderboard?${qs(a)}`, { location: a.location_id }),
  },
];

export const quotasModule: Module = {
  name: 'quotas',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE sales_quotas (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        scope TEXT NOT NULL, subject_id TEXT NOT NULL, period TEXT NOT NULL, period_start TEXT NOT NULL,
        metric TEXT NOT NULL DEFAULT 'won_value', target REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(location_id, scope, subject_id, period, period_start, metric)
      );
      CREATE INDEX sales_quotas_period ON sales_quotas(location_id, period, period_start);
      CREATE TABLE quota_settings (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        leaderboard TEXT, currency TEXT NOT NULL DEFAULT 'EUR', updated_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    // --- what a person may see ----------------------------------------------------------------------------------------------------
    const settingsOf = (loc: string) => {
      const r = db.get<{ leaderboard: string | null; currency: string }>('SELECT leaderboard, currency FROM quota_settings WHERE location_id = ?', loc);
      return { leaderboard: (r?.leaderboard === 'all' || r?.leaderboard === 'own' || r?.leaderboard === 'off' ? r.leaderboard : null) as 'all' | 'own' | 'off' | null, currency: r?.currency || 'EUR' };
    };
    /** Who sees whose numbers: a setting; without one everybody sees all – except people whose deals are limited by record access, who see their own. */
    const visibility = (ctx: Ctx | WidgetCtx['ctx']): 'all' | 'own' | 'off' => {
      const s = settingsOf(ctx.locationId).leaderboard;
      if (s === 'off') return canConfigure(app, ctx) ? 'all' : 'off';
      if (s) return s;
      return limits(resolve(app, ctx), 'deals') ? 'own' : 'all';
    };

    const tzOf = (loc: string) => app.location(loc)?.timezone ?? 'Europe/Berlin';
    const teamsOf = (loc: string) =>
      db.all<{ id: string; name: string }>('SELECT id, name FROM sales_teams WHERE location_id = ? ORDER BY name', loc).map((t) => ({
        ...t,
        members: db.all<{ user_id: string }>('SELECT user_id FROM sales_team_members WHERE team_id = ?', t.id).map((m) => m.user_id),
      }));
    const people = (loc: string) => peopleOf(app, loc, '').map((p) => ({ id: p.id, name: p.name }));

    const parseWhen = (loc: string, q: URLSearchParams | Record<string, unknown>) => {
      const get = (k: string) => (q instanceof URLSearchParams ? q.get(k) : (q[k] as string | undefined));
      const kind = (PERIODS as readonly string[]).includes(String(get('period'))) ? (get('period') as PeriodKind) : 'month';
      const metric = (METRICS as readonly string[]).includes(String(get('metric'))) ? (get('metric') as Metric) : 'won_value';
      const raw = String(get('start') ?? '');
      let start: string;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw) start = periodStart(kind, raw);
      else if (raw) throw bad('Start: Datum als JJJJ-MM-TT angeben');
      else start = currentPeriod(kind, new Date(), tzOf(loc)).start;
      return { kind, metric, start };
    };

    const build = (loc: string, when: { kind: PeriodKind; start: string; metric: Metric }) => standings(app, loc, { ...when, currency: settingsOf(loc).currency, tz: tzOf(loc), people: people(loc), teams: teamsOf(loc) });

    /** The rows this person may see (their own and their teams' when numbers are private). */
    const visible = (ctx: Ctx | WidgetCtx['ctx'], rows: Standing[]): Standing[] => {
      const mode = visibility(ctx);
      if (mode === 'all') return rows;
      if (mode === 'off') return [];
      const me = ctx.user?.id;
      const myTeams = new Set(teamsOf(ctx.locationId).filter((t) => me && t.members.includes(me)).map((t) => t.id));
      return rows.filter((r) => (r.scope === 'user' && r.subject_id === me) || (r.scope === 'team' && myTeams.has(r.subject_id)));
    };

    // --- quotas -----------------------------------------------------------------------------------------------------------------------
    router.get('/api/quotas', 'location', (ctx) => {
      const when = parseWhen(ctx.locationId, ctx.query);
      const mode = visibility(ctx);
      const b = build(ctx.locationId, when);
      const s = settingsOf(ctx.locationId);
      return {
        period: { kind: when.kind, start: b.range.start, end: b.range.end, label: b.range.label, prev: shiftPeriod(when.kind, when.start, -1), next: shiftPeriod(when.kind, when.start, 1), elapsed_pct: b.elapsed_pct, days_left: b.days_left },
        metric: when.metric,
        metric_labels: METRIC_LABEL,
        currency: s.currency,
        rows: visible(ctx, b.rows),
        can_edit: canConfigure(app, ctx),
        leaderboard: s.leaderboard,
        visibility: mode,
        people: canConfigure(app, ctx) ? people(ctx.locationId) : [],
        teams: canConfigure(app, ctx) ? teamsOf(ctx.locationId).map((t) => ({ id: t.id, name: t.name, members: t.members.length })) : [],
        quotas: canConfigure(app, ctx) ? db.all<{ id: string; scope: string; subject_id: string; target: number }>('SELECT id, scope, subject_id, target FROM sales_quotas WHERE location_id = ? AND period = ? AND period_start = ? AND metric = ? AND currency = ?', ctx.locationId, when.kind, b.range.start, when.metric, s.currency) : [],
      };
    });

    router.put('/api/quotas', 'location', (ctx) => {
      mustConfigure(app, ctx);
      const loc = ctx.locationId;
      const when = parseWhen(loc, ctx.body ?? {});
      const list = ctx.body?.quotas;
      if (!Array.isArray(list) || !list.length) throw bad('quotas: Liste von {scope, subject_id, target} erwartet');
      if (list.length > 500) throw bad('Höchstens 500 Quoten auf einmal');
      const peopleIds = new Set(people(loc).map((p) => p.id));
      const teamIds = new Set(teamsOf(loc).map((t) => t.id));
      const currency = settingsOf(loc).currency;
      db.tx(() => {
        for (const q of list) {
          const scope = q?.scope === 'team' ? 'team' : q?.scope === 'user' ? 'user' : null;
          if (!scope) throw bad('scope: user oder team');
          const subject = String(q.subject_id ?? '');
          if (!(scope === 'user' ? peopleIds : teamIds).has(subject)) throw bad(scope === 'user' ? 'Die Person gehört nicht zu diesem Sub-Account' : 'Das Team gibt es nicht');
          const target = q.target === null || q.target === '' || q.target === undefined ? 0 : num(q.target, NaN);
          if (!Number.isFinite(target) || target < 0 || target > 1e12) throw bad('Ziel: Zahl von 0 bis 1.000.000.000.000');
          if (!target) {
            db.run('DELETE FROM sales_quotas WHERE location_id = ? AND scope = ? AND subject_id = ? AND period = ? AND period_start = ? AND metric = ?', loc, scope, subject, when.kind, when.start, when.metric);
            continue;
          }
          db.run(
            `INSERT INTO sales_quotas (id, location_id, scope, subject_id, period, period_start, metric, target, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(location_id, scope, subject_id, period, period_start, metric) DO UPDATE SET target = excluded.target, currency = excluded.currency, updated_at = excluded.updated_at`,
            id(),
            loc,
            scope,
            subject,
            when.kind,
            when.start,
            when.metric,
            target,
            currency,
            ctx.user?.id ?? null,
            now(),
            now(),
          );
        }
      });
      app.services.audit?.({ action: 'quota.set', summary: `Quoten ${periodRange(when.kind, when.start, tzOf(loc)).label}: ${list.length} Eintrag/Einträge`, locationId: loc, userId: ctx.user?.id });
      const b = build(loc, when);
      return { ok: true, rows: b.rows };
    });

    /** Last month's (quarter's) targets as this one's – the usual start of a new period. */
    router.post('/api/quotas/copy', 'location', (ctx) => {
      mustConfigure(app, ctx);
      const loc = ctx.locationId;
      const to = parseWhen(loc, ctx.body ?? {});
      const from = shiftPeriod(to.kind, to.start, -1);
      const rows = db.all<{ scope: string; subject_id: string; target: number; currency: string }>('SELECT scope, subject_id, target, currency FROM sales_quotas WHERE location_id = ? AND period = ? AND period_start = ? AND metric = ?', loc, to.kind, from, to.metric);
      if (!rows.length) throw new HttpError(409, 'In der vorigen Periode gibt es keine Quoten zum Kopieren');
      let n = 0;
      for (const r of rows) {
        n += db.run(
          `INSERT OR IGNORE INTO sales_quotas (id, location_id, scope, subject_id, period, period_start, metric, target, currency, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id(),
          loc,
          r.scope,
          r.subject_id,
          to.kind,
          to.start,
          to.metric,
          r.target,
          r.currency,
          ctx.user?.id ?? null,
          now(),
          now(),
        ).changes;
      }
      return { ok: true, copied: n, skipped: rows.length - n };
    });

    // --- leaderboard ------------------------------------------------------------------------------------------------------------------------
    const board = (ctx: Ctx | WidgetCtx['ctx'], when: { kind: PeriodKind; start: string; metric: Metric }, scope: 'user' | 'team') => {
      const mode = visibility(ctx);
      if (mode === 'off') throw new HttpError(403, 'Die Rangliste ist in diesem Sub-Account ausgeschaltet');
      const b = build(ctx.locationId, when);
      const prev = standings(app, ctx.locationId, { ...when, start: shiftPeriod(when.kind, when.start, -1), currency: settingsOf(ctx.locationId).currency, tz: tzOf(ctx.locationId), people: people(ctx.locationId), teams: teamsOf(ctx.locationId) });
      const before = new Map(prev.rows.filter((r) => r.scope === scope).map((r) => [r.subject_id, r.achieved]));
      const ranked = rank(b.rows.filter((r) => r.scope === scope && (r.achieved > 0 || r.target !== null)));
      const all = ranked.map((r) => ({ ...r, previous: before.get(r.subject_id) ?? 0 }));
      const me = ctx.user?.id;
      const myTeams = new Set(teamsOf(ctx.locationId).filter((t) => me && t.members.includes(me)).map((t) => t.id));
      const shown = mode === 'all' ? all : all.filter((r) => (scope === 'user' ? r.subject_id === me : myTeams.has(r.subject_id)));
      return { range: b.range, elapsed_pct: b.elapsed_pct, days_left: b.days_left, mode, total: all.length, rows: shown.map((r) => ({ rank: r.rank, scope: r.scope, subject_id: r.subject_id, name: r.name, achieved: r.achieved, won_value: r.won_value, won_count: r.won_count, target: r.target, attainment_pct: r.attainment_pct, pace: r.pace, pace_label: r.pace_label, previous: r.previous, me: r.scope === 'user' && r.subject_id === me })) };
    };

    router.get('/api/leaderboard', 'location', (ctx) => {
      const when = parseWhen(ctx.locationId, ctx.query);
      const scope = ctx.query.get('scope') === 'team' ? 'team' : 'user';
      const r = board(ctx, when, scope);
      return { period: { kind: when.kind, start: r.range.start, end: r.range.end, label: r.range.label, prev: shiftPeriod(when.kind, when.start, -1), next: shiftPeriod(when.kind, when.start, 1), elapsed_pct: r.elapsed_pct, days_left: r.days_left }, metric: when.metric, metric_labels: METRIC_LABEL, currency: settingsOf(ctx.locationId).currency, scope, visibility: r.mode, total: r.total, rows: r.rows };
    });

    // --- settings ------------------------------------------------------------------------------------------------------------------------------
    router.get('/api/quota-settings', 'location', (ctx) => ({ ...settingsOf(ctx.locationId), can_edit: canConfigure(app, ctx), effective: visibility(ctx) }));
    router.put('/api/quota-settings', 'location', (ctx) => {
      mustConfigure(app, ctx);
      const cur = settingsOf(ctx.locationId);
      const b = ctx.body ?? {};
      let leaderboard = cur.leaderboard;
      if (b.leaderboard !== undefined) {
        if (b.leaderboard === null || b.leaderboard === '') leaderboard = null;
        else if (b.leaderboard === 'all' || b.leaderboard === 'own' || b.leaderboard === 'off') leaderboard = b.leaderboard;
        else throw bad('Rangliste: all, own oder off');
      }
      let currency = cur.currency;
      if (b.currency !== undefined) {
        try {
          currency = cleanCurrency(b.currency);
        } catch (e) {
          throw bad((e as Error).message);
        }
      }
      db.run(
        `INSERT INTO quota_settings (location_id, leaderboard, currency, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET leaderboard = excluded.leaderboard, currency = excluded.currency, updated_at = excluded.updated_at`,
        ctx.locationId,
        leaderboard,
        currency,
        now(),
      );
      return { ...settingsOf(ctx.locationId), can_edit: true };
    });

    // --- widgets for the living boards ---------------------------------------------------------------------------------------------------------
    const reg = boardWidgets(app);
    const money = (n: number, cur: string) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n);
    const periodField = { key: 'period', label: 'Zeitraum', type: 'select' as const, options: [['month', 'Monat'], ['quarter', 'Quartal']] as [string, string][], default: 'month' };
    const metricField = { key: 'metric', label: 'Kennzahl', type: 'select' as const, options: METRICS.map((m) => [m, METRIC_LABEL[m]] as [string, string]), default: 'won_value' };
    const whenOf = (w: WidgetCtx, c: Record<string, unknown>) => {
      const kind = c.period === 'quarter' ? 'quarter' : 'month';
      return { kind: kind as PeriodKind, metric: (c.metric === 'won_count' ? 'won_count' : 'won_value') as Metric, start: currentPeriod(kind, w.now, w.tz).start };
    };
    const tone = (p: Standing['pace']) => (p === 'reached' || p === 'ahead' ? 'green' : p === 'behind' || p === 'closed' ? 'red' : 'blue');

    reg.register({
      type: 'quota_attainment',
      label: 'Quote: Zielerreichung',
      description: 'Wie weit du (oder das ganze Team) in diesem Monat oder Quartal mit der Quote bist: Erreichtes, Ziel, Erreichung in %, gewichtete Pipeline.',
      icon: 'chart',
      category: 'zahlen',
      keywords: ['quote', 'ziel', 'umsatz', 'vertrieb', 'target', 'quota'],
      access: '/api/quotas',
      accessLabel: 'Vertrieb',
      size: { w: 4, h: 3 },
      source: 'sales',
      fields: [{ key: 'who', label: 'Für', type: 'select', options: [['me', 'Mich'], ['all', 'Alle zusammen']], default: 'me' }, periodField, metricField],
      data: (w, c): View => {
        const when = whenOf(w, c);
        const cur = settingsOf(w.locationId).currency;
        const fmt = (n: number) => (when.metric === 'won_value' ? money(n, cur) : String(n));
        const b = build(w.locationId, when);
        const mode = visibility(w.ctx);
        if (mode === 'off') return { kind: 'locked', reason: 'Die Quoten sind in diesem Sub-Account ausgeschaltet.' };
        const user = b.rows.filter((r) => r.scope === 'user');
        if (c.who === 'all' && mode === 'all') {
          const target = user.reduce((n, r) => n + (r.target ?? 0), 0);
          const achieved = user.reduce((n, r) => n + r.achieved, 0);
          if (!target) return { kind: 'message', text: 'Für diese Periode ist noch keine Quote hinterlegt.', tone: 'yellow', action: { label: 'Quoten festlegen', url: 'sales' } };
          const att = pct(achieved, target);
          return { kind: 'numbers', title: `Quote ${b.range.label}`, items: [{ label: 'Erreicht', value: fmt(achieved) }, { label: 'Ziel', value: fmt(target) }, { label: 'Erreichung', value: att, format: 'percent', tone: att >= 100 ? 'green' : 'blue' }, { label: 'Gewichtete Pipeline', value: money(user.reduce((n, r) => n + r.weighted_pipeline, 0), cur) }], hint: `Noch ${b.days_left} Tage – ${Math.round(b.elapsed_pct)} % der Zeit sind um`, url: 'sales' };
        }
        const mine = user.find((r) => r.subject_id === w.user?.id);
        if (!mine || mine.target === null) return { kind: 'message', text: mine && mine.achieved ? `Du hast ${fmt(mine.achieved)} gewonnen – eine Quote für dich fehlt noch.` : 'Für dich ist in dieser Periode noch keine Quote hinterlegt.', tone: 'yellow', action: { label: 'Zu den Quoten', url: 'sales' } };
        return {
          kind: 'numbers',
          title: `Meine Quote ${b.range.label}`,
          items: [{ label: 'Erreicht', value: fmt(mine.achieved) }, { label: 'Ziel', value: fmt(mine.target) }, { label: 'Erreichung', value: mine.attainment_pct, format: 'percent', tone: tone(mine.pace) }, { label: 'Gewichtete Pipeline', value: money(mine.weighted_pipeline, cur) }],
          hint: `${mine.pace_label} – noch ${b.days_left} Tage, ${Math.round(b.elapsed_pct)} % der Zeit sind um`,
          url: 'sales',
        };
      },
    });

    reg.register({
      type: 'sales_leaderboard',
      label: 'Vertriebs-Rangliste',
      description: 'Wer in diesem Monat oder Quartal am meisten gewonnen hat – Personen oder Teams, mit Quote und Erreichung.',
      icon: 'chart',
      category: 'listen',
      keywords: ['rangliste', 'leaderboard', 'ranking', 'vertrieb', 'wettbewerb'],
      access: '/api/leaderboard',
      accessLabel: 'Vertrieb',
      size: { w: 5, h: 4 },
      source: 'sales',
      fields: [{ key: 'scope', label: 'Wer', type: 'select', options: [['user', 'Personen'], ['team', 'Teams']], default: 'user' }, periodField, metricField, { key: 'limit', label: 'Anzahl', type: 'number', default: 5, min: 1, max: 20 }],
      data: (w, c): View => {
        const when = whenOf(w, c);
        const scope = c.scope === 'team' ? 'team' : 'user';
        let r: ReturnType<typeof board>;
        try {
          r = board(w.ctx, when, scope);
        } catch {
          return { kind: 'locked', reason: 'Die Rangliste ist in diesem Sub-Account ausgeschaltet.' };
        }
        const cur = settingsOf(w.locationId).currency;
        const fmt = (n: number) => (when.metric === 'won_value' ? money(n, cur) : String(n));
        const limit = Math.min(20, Math.max(1, Math.round(Number(c.limit) || 5)));
        return {
          kind: 'table',
          title: `Rangliste ${r.range.label}`,
          columns: [{ key: 'rank', label: '#' }, { key: 'name', label: scope === 'team' ? 'Team' : 'Name' }, { key: 'achieved', label: METRIC_LABEL[when.metric], align: 'right' }, { key: 'attainment', label: 'Quote', align: 'right' }],
          rows: r.rows.slice(0, limit).map((x) => ({ rank: x.rank, name: x.me ? `${x.name} (du)` : x.name, achieved: fmt(x.achieved), attainment: x.attainment_pct === null ? '–' : `${x.attainment_pct} %` })),
          total: r.total,
          empty: 'In dieser Periode wurde noch nichts gewonnen.',
          url: 'sales',
        };
      },
    });
  },
};

