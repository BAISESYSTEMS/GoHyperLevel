import type { Module } from '../core/app.js';
import { bad, notFound } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { id, now } from '../core/util.js';
import { applyStatus, localOf, refreshRemote } from '../services/ads-ops.js';
import { cleanRule, describeRule, evaluate, type Rule } from '../services/ads-rules.js';
import { PLATFORMS, activity, audit, connected, loadConnection, type Platform } from '../services/ads-store.js';

/**
 * Rules for running campaigns ("pause when the cost per lead is above 30 €"): checked every 30 minutes against fresh
 * numbers, and on demand. A rule can pause or notify – it can never switch a campaign on or raise a budget. Every
 * hit is logged (rule log, campaign history, audit log) and emits `ads.rule_triggered`.
 */

const EVERY_MS = 30 * 60_000;
const COOLDOWN_MS = 24 * 3600_000;

export interface RuleHit {
  rule_id: string;
  rule: string;
  platform: Platform;
  campaign_id: string;
  campaign: string;
  value: number | null;
  action: string;
  result: string;
}

export const adsRulesModule: Module = {
  name: 'ads-rules',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE ads_rules (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'all', campaign_ref TEXT NOT NULL DEFAULT '',
        metric TEXT NOT NULL, op TEXT NOT NULL, value REAL NOT NULL, window_days INTEGER NOT NULL DEFAULT 3,
        min_spend_cents INTEGER NOT NULL DEFAULT 0, action TEXT NOT NULL DEFAULT 'pause', enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT, last_triggered_at TEXT, times_triggered INTEGER NOT NULL DEFAULT 0,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX ads_rules_loc ON ads_rules(location_id);
      CREATE TABLE ads_rule_log (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL, rule_name TEXT NOT NULL, platform TEXT NOT NULL, campaign_id TEXT NOT NULL, campaign_name TEXT NOT NULL DEFAULT '',
        value REAL, action TEXT NOT NULL, result TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX ads_rule_log_loc ON ads_rule_log(location_id, created_at);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';
    const dayAgo = (loc: string, n: number) => ymdInTz(new Date(Date.now() - n * 864e5), tzOf(loc));

    const outRule = (r: any) => ({ ...r, enabled: !!r.enabled, text: describeRule(r) });

    /** Does this rule apply to the campaign (platform, and HyperLevel id or platform id)? */
    const applies = (loc: string, r: Rule, platform: Platform, campaignId: string) => {
      if (r.platform !== 'all' && r.platform !== platform) return false;
      if (!r.campaign_ref) return true;
      const m = /^(meta|google):(\d+)$/.exec(r.campaign_ref);
      if (m) return m[1] === platform && m[2] === campaignId;
      const row = db.get<{ platform: string; remote_id: string | null }>('SELECT platform, remote_id FROM ads_campaigns WHERE id = ? AND location_id = ?', r.campaign_ref, loc);
      return !!row && row.platform === platform && row.remote_id === campaignId;
    };

    async function run(locationId: string, o: { dryRun?: boolean; fresh?: boolean } = {}): Promise<{ checked: number; hits: RuleHit[] }> {
      const rules = db.all<Rule>('SELECT * FROM ads_rules WHERE location_id = ? AND enabled = 1', locationId);
      const hits: RuleHit[] = [];
      if (!rules.length) return { checked: 0, hits };
      // Fresh numbers first: yesterday's would pause too late – or too often.
      if (o.fresh && !o.dryRun) {
        for (const p of PLATFORMS) {
          if (!connected(app, p, loadConnection(app, locationId, p))) continue;
          await app.services.adsSync?.(locationId, p, 2).catch((e: Error) => console.warn('[ads] rules sync', locationId, p, e.message));
          await refreshRemote(app, locationId, p).catch((e) => console.warn('[ads] rules refresh', locationId, p, (e as Error).message));
        }
      }
      const active = db.all<{ platform: Platform; campaign_id: string; name: string }>(`SELECT platform, campaign_id, name FROM ads_remote WHERE location_id = ? AND status = 'active'`, locationId);
      const reports = new Map<number, any[]>();
      const rowsFor = (days: number) => {
        if (!reports.has(days)) reports.set(days, app.services.adsReport?.(locationId, dayAgo(locationId, days - 1), dayAgo(locationId, 0), 'last')?.rows ?? []);
        return reports.get(days)!;
      };
      let checked = 0;
      for (const rule of rules) {
        for (const c of active) {
          if (!applies(locationId, rule, c.platform, c.campaign_id)) continue;
          const row = rowsFor(rule.window_days).find((r) => r.platform === c.platform && String(r.campaign_id) === c.campaign_id);
          if (!row) continue;
          checked++;
          const res = evaluate(rule, row);
          if (!res.hit) continue;
          const recent = db.get('SELECT 1 FROM ads_rule_log WHERE rule_id = ? AND platform = ? AND campaign_id = ? AND created_at > ?', rule.id, c.platform, c.campaign_id, new Date(Date.now() - COOLDOWN_MS).toISOString());
          if (recent && !o.dryRun) continue;
          const hit: RuleHit = { rule_id: rule.id, rule: rule.name, platform: c.platform, campaign_id: c.campaign_id, campaign: c.name, value: res.value, action: rule.action, result: o.dryRun ? 'würde ausgelöst' : '' };
          if (!o.dryRun) {
            try {
              if (rule.action === 'pause') {
                await applyStatus(app, undefined, { locationId, platform: c.platform, remoteId: c.campaign_id, status: 'paused', actor: `Regel „${rule.name}“`, why: describeRule(rule, row.currency) });
                hit.result = 'pausiert';
              } else hit.result = 'gemeldet';
            } catch (e) {
              hit.result = `Fehler: ${(e as Error).message}`.slice(0, 300);
            }
            db.insert('ads_rule_log', { id: id(), location_id: locationId, rule_id: rule.id, rule_name: rule.name, platform: c.platform, campaign_id: c.campaign_id, campaign_name: c.name, value: res.value, action: rule.action, result: hit.result, created_at: now() });
            db.run('UPDATE ads_rules SET last_triggered_at = ?, times_triggered = times_triggered + 1 WHERE id = ?', now(), rule.id);
            const local = localOf(app, locationId, c.platform, c.campaign_id);
            const summary = `Regel „${rule.name}“ hat bei „${c.name}“ ausgelöst: ${hit.result}`;
            audit(app, undefined, 'ads.rule.trigger', summary, { locationId, entityId: rule.id, actor: `Regel „${rule.name}“` });
            activity(app, locationId, { campaignId: local?.id, platform: c.platform, remoteId: c.campaign_id, kind: 'rule', summary, actor: `Regel „${rule.name}“`, via: 'system' });
            app.events.emit(locationId, 'ads.rule_triggered', { ruleId: rule.id, rule: rule.name, platform: c.platform, campaignId: c.campaign_id, campaign: c.name, value: res.value, action: rule.action, result: hit.result });
          }
          hits.push(hit);
        }
        if (!o.dryRun) db.run('UPDATE ads_rules SET last_run_at = ? WHERE id = ?', now(), rule.id);
      }
      return { checked, hits };
    }
    app.services.adsRulesRun = run;

    router.get('/api/ads/rules', 'location', (ctx) => ({
      rules: db.all('SELECT * FROM ads_rules WHERE location_id = ? ORDER BY created_at', ctx.locationId).map(outRule),
      log: db.all('SELECT * FROM ads_rule_log WHERE location_id = ? ORDER BY created_at DESC LIMIT 50', ctx.locationId),
    }));

    router.post('/api/ads/rules', 'location', (ctx) => {
      const r = cleanRule(ctx.body, bad);
      if (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ads_rules WHERE location_id = ?', ctx.locationId)!.n >= 50) throw bad('Höchstens 50 Regeln je Sub-Account');
      const row = { id: id(), location_id: ctx.locationId, ...r, enabled: ctx.body?.enabled === false ? 0 : 1, created_by: ctx.user?.id ?? null, created_at: now(), updated_at: now() };
      db.insert('ads_rules', row);
      audit(app, ctx, 'ads.rule.create', `Regel „${row.name}“: ${describeRule(row)}`, { locationId: ctx.locationId, entityId: row.id });
      return outRule(db.get('SELECT * FROM ads_rules WHERE id = ?', row.id));
    });

    router.patch('/api/ads/rules/:id', 'location', (ctx) => {
      const cur = db.get('SELECT * FROM ads_rules WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!cur) throw notFound('Regel nicht gefunden');
      const r = cleanRule({ ...cur, ...ctx.body }, bad);
      db.run('UPDATE ads_rules SET name = ?, platform = ?, campaign_ref = ?, metric = ?, op = ?, value = ?, window_days = ?, min_spend_cents = ?, action = ?, enabled = ?, updated_at = ? WHERE id = ?', r.name, r.platform, r.campaign_ref, r.metric, r.op, r.value, r.window_days, r.min_spend_cents, r.action, ctx.body?.enabled === undefined ? cur.enabled : ctx.body.enabled ? 1 : 0, now(), cur.id);
      return outRule(db.get('SELECT * FROM ads_rules WHERE id = ?', cur.id));
    });

    router.delete('/api/ads/rules/:id', 'location', (ctx) => {
      if (!db.run('DELETE FROM ads_rules WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound('Regel nicht gefunden');
      return { ok: true };
    });

    /** "Jetzt prüfen": with `dry_run` only says what would happen. */
    router.post('/api/ads/rules/run', 'location', (ctx) => run(ctx.locationId, { dryRun: ctx.body?.dry_run === true, fresh: ctx.body?.fresh !== false }));

    const last = new Map<string, number>();
    let ticking = false;
    app.onTick(async () => {
      if (ticking) return;
      ticking = true;
      try {
        for (const r of db.all<{ location_id: string }>('SELECT DISTINCT location_id FROM ads_rules WHERE enabled = 1')) {
          if (Date.now() - (last.get(r.location_id) ?? 0) < EVERY_MS) continue;
          last.set(r.location_id, Date.now());
          await run(r.location_id, { fresh: true }).catch((e) => console.warn('[ads] rules', r.location_id, (e as Error).message));
        }
      } finally {
        ticking = false;
      }
    });
  },
};

