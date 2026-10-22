import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, clampLimit, notFound, str } from '../core/http.js';
import { ymdInTz, zonedToUtc } from '../core/time.js';
import { now } from '../core/util.js';
import { addTags } from '../services/contacts.js';
import { SUNSET_NAME, addressBlocks, checkSummary, ensureSunsetSegment, softBounceSuspects, suppressSoftBounces, validatePending } from '../services/mk-hygiene.js';
import { LEVEL_LABEL, THRESHOLDS, buildReport, summary } from '../services/mk-reputation.js';
import { segmentMemberIds } from '../services/mk-segments.js';
import { getSettings, saveSettings } from '../services/mk-settings.js';
import { defaultResolver, validateMany, VERDICT_LABEL } from '../services/mk-validate.js';
import { PLAN_INFO, WARMUP_PLANS, WARMUP_TARGET, isWarmupPlan, schedule, warmupState, type WarmupPlan } from '../services/mk-warmup.js';
import { cleanDomain, type DnsResolver } from '../services/umzug-mailcheck.js';
import type { Tool } from './mcp.js';

/**
 * Deliverability: the warm-up plan of a new sending domain (daily caps that rise, honoured by the campaign loop), the reputation
 * dashboard (bounce, complaint and unsubscribe rates per campaign, recipient domain and week, with thresholds and warnings),
 * list hygiene (soft bounces, sunset segment) and the address checks (syntax, MX, disposable, role). Docs: docs/email-marketing.md.
 */

const TOOLS: Tool[] = [
  {
    name: 'ghl_deliverability_report',
    title: 'Zustellbarkeit & Reputation',
    description:
      'Bounce-, Beschwerde- und Abmelderaten der Kampagnen-Mails eines Projekts (gesamt, je Kampagne, je Empfänger-Domain, je Woche) mit Schwellen und Warnungen, dazu der Stand des Aufwärmplans (Tageslimit) und die Adressprüfung (ungültig/riskant).',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, days: { type: 'number', description: 'Zeitraum in Tagen (7–365, Standard 90)' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const q = a.days ? `?days=${encodeURIComponent(String(a.days))}` : '';
      const [report, warmup, addresses] = await Promise.all([
        call.api('GET', `/api/deliverability/reputation${q}`, { location: a.location_id }),
        call.api('GET', '/api/deliverability/warmup', { location: a.location_id }),
        call.api('GET', '/api/email-validation/summary', { location: a.location_id }),
      ]);
      return { reputation: { level: report.totals.level, rates: report.totals.rates, sent: report.totals.sent, warnings: report.warnings, by_campaign: report.by_campaign.slice(0, 10).map((c: any) => ({ name: c.label, sent: c.sent, level: c.level, rates: c.rates })) }, warmup: warmup.state, addresses };
    },
  },
];

/** Plans for the picker and the schedule of the chosen one. */
const planList = () => WARMUP_PLANS.map((p) => ({ key: p, ...PLAN_INFO[p], schedule: schedule(p).slice(0, 14) }));

export const mkDeliverabilityModule: Module = {
  name: 'mk-deliverability',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE mk_warmup (
        location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
        plan TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE mk_email_checks (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        email TEXT NOT NULL, verdict TEXT NOT NULL, issues TEXT NOT NULL DEFAULT '[]', role INTEGER NOT NULL DEFAULT 0,
        disposable INTEGER NOT NULL DEFAULT 0, mx INTEGER, checked_at TEXT NOT NULL
      );
      CREATE INDEX mk_email_checks_loc ON mk_email_checks(location_id, verdict);
      CREATE INDEX IF NOT EXISTS activities_loc_type ON activities(location_id, type, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    /** Real DNS lookups only on a running server (tests and offline runs check syntax and word lists only). */
    const resolver = (): DnsResolver | null => app.services.mkResolver ?? (app.config.tickMs > 0 ? defaultResolver() : null);

    // --- warm-up --------------------------------------------------------------------------------------------------
    const sentToday = (loc: string) => {
      const tz = tzOf(loc);
      const from = zonedToUtc(ymdInTz(new Date(), tz), '00:00', tz).toISOString();
      return Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE location_id = ? AND direction = 'out' AND channel = 'email' AND created_at >= ? AND source LIKE 'Kampagne%' AND status NOT IN ('failed', 'queued', 'draft')`, loc, from)?.n ?? 0);
    };
    const warmupRow = (loc: string) => db.get<{ plan: WarmupPlan; domain: string; started_at: string; paused: number }>('SELECT * FROM mk_warmup WHERE location_id = ?', loc);
    const stateOf = (loc: string) => {
      const w = warmupRow(loc);
      if (!w || !isWarmupPlan(w.plan)) return null;
      return warmupState({ plan: w.plan, startedAt: w.started_at, paused: !!w.paused, trouble: summary(app, loc).level === 'critical', sentToday: sentToday(loc), at: new Date(), tz: tzOf(loc) });
    };
    // The campaign loop asks before every batch: how many more marketing e-mails may go out today (null = no cap).
    app.services.mkWarmup = {
      state: stateOf,
      active: (loc: string) => !!stateOf(loc)?.active,
      room: (loc: string) => {
        const s = stateOf(loc);
        return s && s.cap !== null ? s.remaining : null;
      },
    };
    app.services.mkReputation = (loc: string) => summary(app, loc);
    app.services.mkEmailBlocks = (loc: string, contacts: { id: string; email: string }[]) => addressBlocks(app, loc, contacts);

    router.get('/api/deliverability/warmup', 'location', (ctx) => {
      const w = warmupRow(ctx.locationId);
      return { configured: !!w, plan: w?.plan ?? null, domain: w?.domain ?? '', started_at: w?.started_at ?? null, state: stateOf(ctx.locationId), plans: planList(), target_per_day: WARMUP_TARGET };
    });
    router.post('/api/deliverability/warmup', 'location', (ctx) => {
      const plan = ctx.body?.plan === undefined ? 'standard' : ctx.body.plan;
      if (!isWarmupPlan(plan)) throw bad('Unbekannter Plan');
      const domainIn = str(ctx.body?.domain, 'Domain', { max: 253 });
      const domain = domainIn ? cleanDomain(domainIn) : '';
      if (domainIn && !domain) throw bad('Die Domain ist ungültig (z. B. „firma.de“)');
      db.run(
        `INSERT INTO mk_warmup (location_id, plan, domain, started_at, paused, updated_at) VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(location_id) DO UPDATE SET plan = excluded.plan, domain = excluded.domain, started_at = excluded.started_at, paused = 0, updated_at = excluded.updated_at`,
        ctx.locationId,
        plan,
        domain ?? '',
        now(),
        now(),
      );
      return { configured: true, plan, domain: domain ?? '', state: stateOf(ctx.locationId) };
    });
    router.put('/api/deliverability/warmup', 'location', (ctx) => {
      const w = warmupRow(ctx.locationId);
      if (!w) throw notFound('Es läuft kein Aufwärmplan');
      if (ctx.body?.plan !== undefined) {
        if (!isWarmupPlan(ctx.body.plan)) throw bad('Unbekannter Plan');
        db.run('UPDATE mk_warmup SET plan = ?, updated_at = ? WHERE location_id = ?', ctx.body.plan, now(), ctx.locationId);
      }
      if (ctx.body?.paused !== undefined) db.run('UPDATE mk_warmup SET paused = ?, updated_at = ? WHERE location_id = ?', ctx.body.paused ? 1 : 0, now(), ctx.locationId);
      return { configured: true, state: stateOf(ctx.locationId) };
    });
    router.delete('/api/deliverability/warmup', 'location', (ctx) => {
      db.run('DELETE FROM mk_warmup WHERE location_id = ?', ctx.locationId);
      return { ok: true };
    });

    // --- reputation ----------------------------------------------------------------------------------------------
    router.get('/api/deliverability/reputation', 'location', (ctx) => ({
      ...buildReport(app, ctx.locationId, { days: clampLimit(ctx.query.get('days'), 90, 365) }),
      thresholds: THRESHOLDS,
      level_labels: LEVEL_LABEL,
    }));

    // --- settings -----------------------------------------------------------------------------------------------
    router.get('/api/deliverability/settings', 'location', (ctx) => getSettings(app, ctx.locationId));
    router.put('/api/deliverability/settings', 'location', (ctx) => saveSettings(app, ctx.locationId, ctx.body));

    // --- hygiene -----------------------------------------------------------------------------------------------
    router.get('/api/deliverability/hygiene', 'location', (ctx) => {
      const s = getSettings(app, ctx.locationId);
      const suspects = softBounceSuspects(app, ctx.locationId, s.hygiene.soft_bounce_limit);
      const sunset = db.get<{ id: string; count: number | null }>('SELECT id, count FROM mk_segments WHERE location_id = ? AND name = ?', ctx.locationId, SUNSET_NAME);
      const dnd = Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE location_id = ? AND dnd = 1', ctx.locationId)?.n ?? 0);
      return { soft_bounce_limit: s.hygiene.soft_bounce_limit, auto_suppress: s.hygiene.auto_suppress, suspects: suspects.slice(0, 50), suspect_count: suspects.length, sunset_months: s.hygiene.sunset_months, sunset_segment: sunset ?? null, dnd };
    });
    router.post('/api/deliverability/hygiene/suppress', 'location', (ctx) => {
      const only = Array.isArray(ctx.body?.contact_ids) ? ctx.body.contact_ids.map(String).slice(0, 5000) : undefined;
      return suppressSoftBounces(app, ctx.locationId, only);
    });
    /** Creates the sunset segment (contacts who never open) – optionally tags them. */
    router.post('/api/deliverability/hygiene/sunset', 'location', (ctx) => {
      const months = Math.min(36, Math.max(1, Math.round(Number(ctx.body?.months) || getSettings(app, ctx.locationId).hygiene.sunset_months)));
      const seg = ensureSunsetSegment(app, ctx.locationId, months);
      let tagged = 0;
      if (ctx.body?.tag) {
        const tag = str(ctx.body.tag, 'Tag', { max: 80 }) || 'inaktiv';
        const ids = db.all<{ id: string }>(`SELECT id FROM contacts WHERE location_id = ?`, ctx.locationId);
        // The segment decides who is inactive; contacts are tagged from its member list.
        const members = new Set(segmentMemberIds(app, ctx.locationId, seg.id) ?? []);
        for (const c of ids) if (members.has(c.id)) (addTags(app, ctx.locationId, c.id, [tag]), tagged++);
      }
      return { segment_id: seg.id, count: seg.count, months, tagged };
    });

    // --- address checks ------------------------------------------------------------------------------------------
    router.post('/api/email-validation/check', 'location', async (ctx) => {
      const list = Array.isArray(ctx.body?.emails) ? ctx.body.emails.slice(0, 200) : typeof ctx.body?.email === 'string' ? [ctx.body.email] : [];
      if (!list.length) throw bad('Keine Adressen angegeben');
      const results = await validateMany(list, ctx.body?.mx === false ? null : resolver());
      return { results: results.map((r) => ({ ...r, verdict_label: VERDICT_LABEL[r.verdict] })) };
    });
    router.get('/api/email-validation/summary', 'location', (ctx) => ({ ...checkSummary(app, ctx.locationId), settings: getSettings(app, ctx.locationId).validation }));
    /** Checks the next addresses of this sub-account now (the hourly job does the same in the background). */
    router.post('/api/email-validation/scan', 'location', async (ctx) => {
      const r = await validatePending(app, { locationId: ctx.locationId, limit: clampLimit(ctx.body?.limit, 100, 500), resolver: resolver() });
      return { ...r, summary: checkSummary(app, ctx.locationId) };
    });
    router.get('/api/email-validation/issues', 'location', (ctx) => {
      const verdict = ['invalid', 'risky'].includes(String(ctx.query.get('verdict'))) ? String(ctx.query.get('verdict')) : 'invalid';
      const rows = parseRows(
        db.all(
          `SELECT k.contact_id, k.email, k.verdict, k.issues, k.checked_at, c.first_name, c.last_name FROM mk_email_checks k JOIN contacts c ON c.id = k.contact_id AND c.email = k.email
           WHERE k.location_id = ? AND c.location_id = ? AND k.verdict = ? ORDER BY k.checked_at DESC LIMIT ?`,
          ctx.locationId,
          ctx.locationId,
          verdict,
          clampLimit(ctx.query.get('limit'), 50, 200),
        ),
        ['issues'],
      );
      return rows;
    });
    /** Tags the contacts whose address failed (or looks risky) so they can be fixed or cleaned up from the contact list. */
    router.post('/api/email-validation/tag', 'location', (ctx) => {
      const verdicts = ctx.body?.verdict === 'risky' ? ['invalid', 'risky'] : ['invalid'];
      const tag = str(ctx.body?.tag, 'Tag', { max: 80 }) || 'E-Mail prüfen';
      const rows = db.all<{ contact_id: string }>(`SELECT k.contact_id FROM mk_email_checks k JOIN contacts c ON c.id = k.contact_id AND c.email = k.email WHERE k.location_id = ? AND c.location_id = ? AND k.verdict IN (${verdicts.map(() => '?').join(',')})`, ctx.locationId, ctx.locationId, ...verdicts);
      for (const r of rows) addTags(app, ctx.locationId, r.contact_id, [tag]);
      return { tagged: rows.length, tag };
    });

    // --- background work -----------------------------------------------------------------------------------------
    let nextScan = 0;
    let lastSweep = 0;
    /** Soft-bounce suspects of every sub-account that allows it go on "Nicht stören". */
    const sweep = () => {
      for (const l of db.all<{ id: string }>('SELECT id FROM locations')) {
        if (getSettings(app, l.id).hygiene.auto_suppress) suppressSoftBounces(app, l.id);
      }
    };
    /** The address checks run in small steps (a pass over the contacts is not free) and the sweep once an hour; `force` for tests. */
    const jobs = async (force = false) => {
      const t = Date.now();
      if (force || t >= nextScan) {
        nextScan = t + 20_000;
        const r = await validatePending(app, { limit: 25, resolver: resolver(), retryDns: true });
        // More to do: soon again; all done: rest for a while.
        nextScan = t + (r.left ? 20_000 : r.checked ? 60_000 : 10 * 60_000);
      }
      if (force || t - lastSweep > 3600_000) {
        lastSweep = t;
        sweep();
      }
    };
    app.services.mkJobs = jobs;
    app.onTick(() => jobs());
  },
};

