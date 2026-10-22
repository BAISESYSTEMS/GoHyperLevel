import type { Module } from '../core/app.js';
import { parseJson, parseRows } from '../core/db.js';
import { bad, notFound, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { evalCondition } from '../services/workflow-engine.js';
import { contactScopeClause, maskContactFields, resolve } from '../services/record-access.js';
import type { SnapshotPart } from '../services/snapshots.js';
import { SCORE_EVENTS, SCORE_OPS, ScoreError, cleanModel, labelRank, scoreFrom, type ScoreModel, type ScoreRule } from '../services/lead-scoring.js';
import type { AssociationsService } from './associations.js';
import type { Tool } from './mcp.js';

/**
 * Lead scoring per sub-account: models with property and engagement rules, decay and thresholds
 * (see services/lead-scoring.ts). Scores update on events and every night, keep a history, can
 * be filtered/sorted in contact lists (primary model) and start workflows when they reach a
 * threshold or change.
 */

export const SCORE_TRIGGERS = ['lead_score.threshold_reached', 'lead_score.changed'];

/** Engagement counts per contact, read from the tables that already record them. */
const SOURCES: Record<string, { table: string; at: string; where: string }> = {
  'email.opened': { table: 'messages', at: 'opened_at', where: `channel = 'email' AND opened_at IS NOT NULL` },
  'email.clicked': { table: 'messages', at: 'clicked_at', where: `channel = 'email' AND clicked_at IS NOT NULL` },
  'form.submitted': { table: 'form_submissions', at: 'created_at', where: '1 = 1' },
  'page.visited': { table: 'attribution_touches', at: 'created_at', where: '1 = 1' },
  'appointment.booked': { table: 'appointments', at: 'created_at', where: `status != 'blocked'` },
  'message.inbound': { table: 'messages', at: 'created_at', where: `direction = 'in'` },
  'chat.inbound': { table: 'messages', at: 'created_at', where: `direction = 'in' AND channel = 'chat'` },
  'whatsapp.inbound': { table: 'messages', at: 'created_at', where: `direction = 'in' AND channel = 'whatsapp'` },
  'sms.inbound': { table: 'messages', at: 'created_at', where: `direction = 'in' AND channel = 'sms'` },
  'email.inbound': { table: 'messages', at: 'created_at', where: `direction = 'in' AND channel = 'email'` },
  'call.completed': { table: 'calls', at: 'started_at', where: 'answered = 1' },
  'opportunity.created': { table: 'opportunities', at: 'created_at', where: '1 = 1' },
};

const MODEL_JSON = ['rules', 'thresholds', 'decay'];
const modelOut = (m: any) => (m ? { ...parseJson(m, MODEL_JSON), active: !!m.active, is_primary: !!m.is_primary } : m);

export const leadScoringModule: Module = {
  name: 'lead-scoring',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE lead_score_models (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, is_primary INTEGER NOT NULL DEFAULT 0,
        rules TEXT NOT NULL DEFAULT '[]', thresholds TEXT NOT NULL DEFAULT '[]', decay TEXT NOT NULL DEFAULT '{}',
        max_score INTEGER, dirty INTEGER NOT NULL DEFAULT 0, calculated_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE lead_scores (
        model_id TEXT NOT NULL REFERENCES lead_score_models(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        score INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL DEFAULT '', breakdown TEXT NOT NULL DEFAULT '[]',
        last_engagement_at TEXT, calculated_at TEXT NOT NULL, changed_at TEXT,
        PRIMARY KEY (model_id, contact_id)
      );
      CREATE INDEX lead_scores_contact ON lead_scores(contact_id);
      CREATE INDEX lead_scores_model_score ON lead_scores(model_id, score);
      CREATE TABLE lead_score_history (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL, model_id TEXT NOT NULL REFERENCES lead_score_models(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, score INTEGER NOT NULL, previous INTEGER,
        label TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX lead_score_history_contact ON lead_score_history(contact_id, created_at);
      CREATE TABLE lead_score_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS form_submissions_contact ON form_submissions(contact_id, created_at);
      CREATE INDEX IF NOT EXISTS messages_contact ON messages(contact_id, created_at);
      CREATE INDEX IF NOT EXISTS appointments_contact ON appointments(contact_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    const A = (): AssociationsService | undefined => app.services.associations;

    const models = (loc: string, onlyActive = false) => db.all(`SELECT * FROM lead_score_models WHERE location_id = ?${onlyActive ? ' AND active = 1' : ''} ORDER BY is_primary DESC, created_at`, loc).map(modelOut);
    const getModel = (loc: string, mid: string) => modelOut(db.get('SELECT * FROM lead_score_models WHERE id = ? AND location_id = ?', mid, loc));
    const tableExists = (t: string) => !!db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, t);

    /** Event counts per contact for one rule (or all events for the last engagement). */
    const counts = (loc: string, event: string, ids: string[] | null, since?: string) => {
      const s = SOURCES[event];
      const out = new Map<string, { n: number; last: string }>();
      if (!s || !tableExists(s.table)) return out;
      const inIds = ids ? ` AND contact_id IN (${ids.map(() => '?').join(',')})` : '';
      const rows = db.all(
        `SELECT contact_id AS cid, COUNT(*) AS n, MAX(${s.at}) AS last FROM ${s.table} WHERE location_id = ? AND contact_id IS NOT NULL AND ${s.where}${since ? ` AND ${s.at} >= ?` : ''}${inIds} GROUP BY contact_id`,
        loc,
        ...(since ? [since] : []),
        ...(ids ?? []),
      );
      for (const r of rows) out.set(r.cid, { n: r.n, last: r.last });
      return out;
    };

    const companiesOf = (loc: string, contactId: string) => {
      const ids = A()?.ids(loc, { type: 'contact', id: contactId }, 'company') ?? [];
      return ids.length ? parseRows(db.all(`SELECT * FROM companies WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids), ['custom']) : [];
    };
    const attributionOf = (contactId: string) => (tableExists('attribution_contacts') ? db.get('SELECT * FROM attribution_contacts WHERE contact_id = ?', contactId) : undefined);

    /** Does a property rule apply to the contact (company rules: any associated company)? */
    const matches = (rule: ScoreRule, contact: any, companies: any[], attribution: any) => {
      const cond = { field: rule.field!, op: rule.op!, value: rule.value };
      if (rule.field === 'tag') return evalCondition({ field: 'tag', op: rule.op === 'not_has' ? 'not_has' : 'has', value: rule.value }, { contact });
      if (rule.field!.startsWith('company.')) {
        const f = { ...cond, field: rule.field! };
        if (!companies.length) return evalCondition(f, { company: {} });
        const positive = !['not_has', 'not_equals', 'empty'].includes(rule.op!);
        return positive ? companies.some((c) => evalCondition(f, { company: c })) : companies.every((c) => evalCondition(f, { company: c }));
      }
      if (rule.field!.startsWith('attribution.')) return evalCondition(cond, { attribution: attribution ?? {} });
      return evalCondition({ ...cond, field: `contact.${rule.field}` }, { contact });
    };

    /** Recalculates scores of one model for the given contacts (all when ids is null). */
    const recompute = (loc: string, model: any, ids: string[] | null, reason: string) => {
      if (!model?.active) return 0;
      const m: ScoreModel = { rules: model.rules ?? [], thresholds: model.thresholds ?? [], decay: { percent: 0, days: 30, ...(model.decay ?? {}) }, max_score: model.max_score ?? null };
      const contacts = parseRows(
        ids ? db.all(`SELECT * FROM contacts WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, loc, ...ids) : db.all('SELECT * FROM contacts WHERE location_id = ?', loc),
        ['tags', 'custom'],
      );
      if (!contacts.length) return 0;
      const cids = ids ? contacts.map((c) => c.id) : null;
      const ruleCounts = new Map<string, Map<string, { n: number; last: string }>>();
      for (const r of m.rules.filter((x) => x.kind === 'event')) ruleCounts.set(r.id, counts(loc, r.event!, cids, r.within_days ? new Date(Date.now() - r.within_days * 864e5).toISOString() : undefined));
      // Last engagement over every source (for the decay).
      const last = new Map<string, string>();
      if (m.decay.percent) {
        for (const ev of Object.keys(SOURCES)) for (const [cid, v] of counts(loc, ev, cids)) if (v.last && (!last.has(cid) || v.last > last.get(cid)!)) last.set(cid, v.last);
      }
      const fieldLabels: Record<string, string> = Object.fromEntries([
        ...db.all('SELECT key, label FROM custom_fields WHERE location_id = ?', loc).map((f) => [`custom.${f.key}`, f.label]),
        ...(tableExists('object_properties') ? db.all(`SELECT key, label FROM object_properties WHERE location_id = ? AND object_key = 'company'`, loc).map((p) => [`company.custom.${p.key}`, `Firma: ${p.label}`]) : []),
      ]);
      const needsCompany = m.rules.some((r) => r.field?.startsWith('company.'));
      const needsAttr = m.rules.some((r) => r.field?.startsWith('attribution.'));
      const existing = new Map(db.all(`SELECT contact_id, score, label FROM lead_scores WHERE model_id = ?${cids ? ` AND contact_id IN (${cids.map(() => '?').join(',')})` : ''}`, model.id, ...(cids ?? [])).map((r) => [r.contact_id, r]));
      const at = now();
      let changed = 0;
      for (const c of contacts) {
        const cos = needsCompany ? companiesOf(loc, c.id) : [];
        const attr = needsAttr ? attributionOf(c.id) : undefined;
        const hit: Record<string, boolean> = {};
        const cnt: Record<string, number> = {};
        for (const r of m.rules) {
          if (r.kind === 'property') hit[r.id] = matches(r, c, cos, attr);
          else cnt[r.id] = ruleCounts.get(r.id)?.get(c.id)?.n ?? 0;
        }
        const lastAt = last.get(c.id) ?? c.last_activity_at ?? c.created_at;
        const res = scoreFrom(m, hit, cnt, lastAt, Date.now(), fieldLabels);
        const prev = existing.get(c.id);
        db.run(
          `INSERT INTO lead_scores (model_id, contact_id, location_id, score, label, breakdown, last_engagement_at, calculated_at, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(model_id, contact_id) DO UPDATE SET score = excluded.score, label = excluded.label, breakdown = excluded.breakdown, last_engagement_at = excluded.last_engagement_at,
             calculated_at = excluded.calculated_at, changed_at = CASE WHEN lead_scores.score != excluded.score THEN excluded.calculated_at ELSE lead_scores.changed_at END`,
          model.id,
          c.id,
          loc,
          res.score,
          res.label,
          JSON.stringify(res.breakdown),
          lastAt,
          at,
          prev && prev.score === res.score ? null : at,
        );
        if (prev && prev.score === res.score) continue;
        if (!prev && res.score === 0) continue;
        changed++;
        db.insert('lead_score_history', { id: id(), location_id: loc, model_id: model.id, contact_id: c.id, score: res.score, previous: prev?.score ?? null, label: res.label, reason, created_at: at });
        app.events.emit(loc, 'lead_score.changed', { contactId: c.id, modelId: model.id, model: model.name, score: res.score, previous: prev?.score ?? 0, label: res.label, previousLabel: prev?.label ?? '', direction: res.score > (prev?.score ?? 0) ? 'up' : 'down' });
        if (labelRank(res.label, m.thresholds) > labelRank(prev?.label ?? '', m.thresholds)) {
          app.events.emit(loc, 'lead_score.threshold_reached', { contactId: c.id, modelId: model.id, model: model.name, threshold: res.label, score: res.score });
        }
      }
      db.run('UPDATE lead_score_models SET calculated_at = ?, dirty = 0 WHERE id = ? AND ? = 1', at, model.id, ids ? 0 : 1);
      // Keep the history short per contact.
      if (ids) for (const cid of ids) db.run('DELETE FROM lead_score_history WHERE contact_id = ? AND id NOT IN (SELECT id FROM lead_score_history WHERE contact_id = ? ORDER BY created_at DESC LIMIT 200)', cid, cid);
      return changed;
    };

    const recomputeContact = (loc: string, contactId: string, reason: string) => {
      for (const m of models(loc, true)) recompute(loc, m, [contactId], reason);
    };

    // --- recalculation on events (batched per tick of the event loop) -------------------------------
    const pending = new Map<string, { loc: string; reason: string }>();
    let scheduled: Promise<void> | null = null;
    const queue = (loc: string, contactId: string, reason: string) => {
      if (!contactId) return scheduled ?? undefined;
      if (!db.get('SELECT 1 FROM lead_score_models WHERE location_id = ? AND active = 1 LIMIT 1', loc)) return scheduled ?? undefined;
      pending.set(contactId, { loc, reason });
      scheduled ??= new Promise<void>((resolve) =>
        setImmediate(() => {
          const batch = [...pending.entries()];
          pending.clear();
          scheduled = null;
          for (const [cid, p] of batch) {
            try {
              recomputeContact(p.loc, cid, p.reason);
            } catch (e) {
              console.error('[lead-scoring]', (e as Error).message);
            }
          }
          resolve();
        }),
      );
      return scheduled;
    };
    const REASONS: Record<string, string> = {
      'contact.created': 'Kontakt angelegt',
      'contact.updated': 'Kontakt geändert',
      'contact.tag_added': 'Tag hinzugefügt',
      'contact.tag_removed': 'Tag entfernt',
      'form.submitted': SCORE_EVENTS['form.submitted'],
      'email.opened': SCORE_EVENTS['email.opened'],
      'email.clicked': SCORE_EVENTS['email.clicked'],
      'appointment.booked': SCORE_EVENTS['appointment.booked'],
      'message.inbound': SCORE_EVENTS['message.inbound'],
      'opportunity.created': SCORE_EVENTS['opportunity.created'],
      'call.completed': SCORE_EVENTS['call.completed'],
      'association.created': 'Verknüpfung geändert',
      'association.removed': 'Verknüpfung geändert',
    };
    for (const [type, reason] of Object.entries(REASONS)) app.events.on(type, (e) => queue(e.locationId, e.data.contactId, reason));
    app.events.on('company.updated', async (e) => {
      for (const cid of A()?.ids(e.locationId, { type: 'company', id: e.data.companyId }, 'contact') ?? []) await queue(e.locationId, cid, 'Firma geändert');
    });
    app.services.attributionHooks = [
      ...(app.services.attributionHooks ?? []),
      { onTouch: (e: any) => e.touch?.contact_id && void queue(e.locationId, e.touch.contact_id, SCORE_EVENTS['page.visited']), onLink: (e: any) => void queue(e.locationId, e.contactId, SCORE_EVENTS['page.visited']) },
    ];

    // Nightly (decay, time windows) plus models marked for a full run.
    const state = (k: string) => db.get('SELECT value FROM lead_score_state WHERE key = ?', k)?.value as string | undefined;
    const setState = (k: string, v: string) => db.run('INSERT INTO lead_score_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
    const nightly = (force = false) => {
      const lastRun = state('nightly');
      if (!force && lastRun && Date.now() - Date.parse(lastRun) < 20 * 3600_000) return false;
      setState('nightly', now());
      for (const m of db.all('SELECT * FROM lead_score_models WHERE active = 1').map(modelOut)) recompute(m.location_id, m, null, 'Nächtliche Neuberechnung');
      return true;
    };
    app.onTick(() => {
      for (const m of db.all('SELECT * FROM lead_score_models WHERE active = 1 AND dirty = 1 LIMIT 5').map(modelOut)) recompute(m.location_id, m, null, 'Regeln geändert');
      if (new Date().getHours() >= 2 || !state('nightly')) nightly();
    });
    app.services.leadScoringNightly = nightly;

    // --- workflows ----------------------------------------------------------------------------------
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...SCORE_TRIGGERS];
    app.services.workflowTriggerFilters = {
      ...(app.services.workflowTriggerFilters ?? {}),
      'lead_score.threshold_reached': (c: any, d: any) => (!c.model_id || c.model_id === d.modelId) && (!c.threshold || String(c.threshold).toLowerCase() === String(d.threshold).toLowerCase()),
      'lead_score.changed': (c: any, d: any) => (!c.model_id || c.model_id === d.modelId) && (!c.direction || c.direction === d.direction) && (c.min === undefined || c.min === '' || Number(d.score) >= Number(c.min)),
    };

    // --- contact lists: filter and sort by the primary model's score ------------------------------
    const PRIMARY = `(SELECT s.score FROM lead_scores s JOIN lead_score_models m ON m.id = s.model_id AND m.is_primary = 1 AND m.active = 1 WHERE s.contact_id = contacts.id)`;
    const PRIMARY_LABEL = `(SELECT s.label FROM lead_scores s JOIN lead_score_models m ON m.id = s.model_id AND m.is_primary = 1 AND m.active = 1 WHERE s.contact_id = contacts.id)`;
    app.services.contactFilters = [
      ...(app.services.contactFilters ?? []),
      (f: any) => {
        const get = (k: string) => String(f?.query?.get?.(k) ?? f?.extra?.[k] ?? '').trim();
        const conds: string[] = [];
        const params: unknown[] = [];
        if (get('score_min') !== '') (conds.push(`COALESCE(${PRIMARY}, 0) >= ?`), params.push(Number(get('score_min')) || 0));
        if (get('score_max') !== '') (conds.push(`COALESCE(${PRIMARY}, 0) <= ?`), params.push(Number(get('score_max')) || 0));
        const label = get('score_label');
        if (label) {
          // "MQL" means MQL or higher (the threshold's minimum in the primary model).
          conds.push(`COALESCE(${PRIMARY}, 0) >= COALESCE((SELECT CAST(json_extract(t.value, '$.min') AS INTEGER) FROM lead_score_models m, json_each(m.thresholds) t WHERE m.location_id = contacts.location_id AND m.is_primary = 1 AND lower(json_extract(t.value, '$.label')) = lower(?)), 1e9)`);
          params.push(label);
        }
        return conds.length ? { sql: conds.join(' AND '), params } : undefined;
      },
    ];
    app.services.contactSorts = { ...(app.services.contactSorts ?? {}), score: () => `COALESCE(${PRIMARY}, -1) DESC, created_at DESC`, score_label: () => `${PRIMARY_LABEL} DESC` };

    // --- API ----------------------------------------------------------------------------------------
    const clean = (b: any) => {
      try {
        return cleanModel(b, () => id(8));
      } catch (e) {
        if (e instanceof ScoreError) throw bad(e.message);
        throw e;
      }
    };
    const stats = (m: any, ctx?: Ctx) => {
      // Record-access rules (modules/record-access.ts): the top list shows the contacts the person may open.
      const access = ctx ? resolve(app, ctx) : null;
      const scope = contactScopeClause(access, 's.contact_id');
      const rows = db.all(`SELECT label, COUNT(*) AS n, AVG(score) AS avg FROM lead_scores s WHERE model_id = ?${scope ? ` AND ${scope.sql}` : ''} GROUP BY label`, m.id, ...(scope?.params ?? []));
      const total = rows.reduce((n, r) => n + r.n, 0);
      return {
        scored: total,
        average: total ? Math.round(rows.reduce((s, r) => s + r.avg * r.n, 0) / total) : 0,
        labels: Object.fromEntries(rows.map((r) => [r.label, r.n])),
        top: db.all(`SELECT s.contact_id, s.score, s.label, c.first_name, c.last_name, c.email FROM lead_scores s JOIN contacts c ON c.id = s.contact_id WHERE s.model_id = ?${scope ? ` AND ${scope.sql}` : ''} ORDER BY s.score DESC LIMIT 10`, m.id, ...(scope?.params ?? [])).map((r) => maskContactFields(access, r)),
      };
    };
    const fullRecalc = (loc: string, m: any) => {
      const n = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM contacts WHERE location_id = ?', loc)!.n;
      if (n <= 5000) recompute(loc, m, null, 'Regeln geändert');
      else db.run('UPDATE lead_score_models SET dirty = 1 WHERE id = ?', m.id);
    };

    router.get('/api/lead-scoring/meta', 'location', (ctx) => ({
      events: SCORE_EVENTS,
      ops: SCORE_OPS,
      custom_fields: db.all('SELECT key, label, type, options FROM custom_fields WHERE location_id = ? ORDER BY position, label', ctx.locationId).map((f) => ({ ...f, options: JSON.parse(f.options || '[]') })),
      company_properties: tableExists('object_properties') ? db.all(`SELECT key, label, type FROM object_properties WHERE location_id = ? AND object_key = 'company' ORDER BY position`, ctx.locationId) : [],
      tags: db.all('SELECT name FROM tags WHERE location_id = ? ORDER BY name', ctx.locationId).map((t) => t.name),
    }));
    router.get('/api/lead-scoring/models', 'location', (ctx) => models(ctx.locationId).map((m) => ({ ...m, stats: stats(m, ctx) })));
    router.post('/api/lead-scoring/models', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (models(ctx.locationId).length >= 10) throw bad('Höchstens 10 Scoring-Modelle');
      const cfg = clean({ thresholds: [{ label: 'MQL', min: 50 }, { label: 'SQL', min: 80 }], decay: { percent: 0, days: 30 }, ...b });
      const first = !db.get('SELECT 1 FROM lead_score_models WHERE location_id = ?', ctx.locationId);
      const row = { id: id(), location_id: ctx.locationId, name: str(b.name, 'Name', { max: 80 }) || 'Lead-Score', active: b.active === false ? 0 : 1, is_primary: first || b.is_primary ? 1 : 0, rules: cfg.rules, thresholds: cfg.thresholds, decay: cfg.decay, max_score: cfg.max_score, created_at: now(), updated_at: now() };
      if (row.is_primary && !first) db.run('UPDATE lead_score_models SET is_primary = 0 WHERE location_id = ?', ctx.locationId);
      db.insert('lead_score_models', row);
      const m = getModel(ctx.locationId, row.id);
      fullRecalc(ctx.locationId, m);
      return { ...getModel(ctx.locationId, row.id), stats: stats(m, ctx) };
    });
    router.get('/api/lead-scoring/models/:id', 'location', (ctx) => {
      const m = getModel(ctx.locationId, ctx.params.id);
      if (!m) throw notFound('Modell nicht gefunden');
      return { ...m, stats: stats(m, ctx) };
    });
    router.patch('/api/lead-scoring/models/:id', 'location', (ctx) => {
      const m = getModel(ctx.locationId, ctx.params.id);
      if (!m) throw notFound('Modell nicht gefunden');
      const b = ctx.body ?? {};
      const cfg = clean({ rules: b.rules ?? m.rules, thresholds: b.thresholds ?? m.thresholds, decay: b.decay ?? m.decay, max_score: b.max_score !== undefined ? b.max_score : m.max_score });
      const patch: Record<string, unknown> = { rules: cfg.rules, thresholds: cfg.thresholds, decay: cfg.decay, max_score: cfg.max_score, updated_at: now() };
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { required: true, max: 80 });
      if (b.active !== undefined) patch.active = b.active ? 1 : 0;
      if (b.is_primary) {
        db.run('UPDATE lead_score_models SET is_primary = 0 WHERE location_id = ?', ctx.locationId);
        patch.is_primary = 1;
      }
      if (cfg.max_score === null) db.run('UPDATE lead_score_models SET max_score = NULL WHERE id = ?', m.id);
      db.update('lead_score_models', m.id, patch);
      const next = getModel(ctx.locationId, m.id);
      if (next.active) fullRecalc(ctx.locationId, next);
      return { ...getModel(ctx.locationId, m.id), stats: stats(next, ctx) };
    });
    router.delete('/api/lead-scoring/models/:id', 'location', (ctx) => {
      const m = getModel(ctx.locationId, ctx.params.id);
      if (!m) throw notFound('Modell nicht gefunden');
      db.run('DELETE FROM lead_score_models WHERE id = ?', m.id);
      if (m.is_primary) db.run('UPDATE lead_score_models SET is_primary = 1 WHERE id = (SELECT id FROM lead_score_models WHERE location_id = ? ORDER BY created_at LIMIT 1)', ctx.locationId);
      return { ok: true };
    });
    router.post('/api/lead-scoring/models/:id/recalculate', 'location', (ctx) => {
      const m = getModel(ctx.locationId, ctx.params.id);
      if (!m) throw notFound('Modell nicht gefunden');
      if (!m.active) throw bad('Modell ist pausiert');
      const changed = recompute(ctx.locationId, m, null, 'Manuell neu berechnet');
      return { changed, ...stats(m, ctx) };
    });

    const contactScores = (loc: string, cid: string) => {
      if (!db.get('SELECT id FROM contacts WHERE id = ? AND location_id = ?', cid, loc)) throw notFound('Kontakt nicht gefunden');
      const scores = parseRows(
        db.all(`SELECT s.*, m.name AS model_name, m.is_primary, m.thresholds FROM lead_scores s JOIN lead_score_models m ON m.id = s.model_id WHERE s.contact_id = ? AND m.location_id = ? ORDER BY m.is_primary DESC, m.created_at`, cid, loc),
        ['breakdown', 'thresholds'],
      ).map((s) => ({ ...s, is_primary: !!s.is_primary }));
      const history = db.all(`SELECT h.*, m.name AS model_name FROM lead_score_history h JOIN lead_score_models m ON m.id = h.model_id WHERE h.contact_id = ? ORDER BY h.created_at DESC LIMIT 50`, cid);
      return { scores, history };
    };
    router.get('/api/lead-scoring/contacts/:id', 'location', (ctx) => contactScores(ctx.locationId, ctx.params.id));
    router.post('/api/lead-scoring/contacts/:id/recalculate', 'location', (ctx) => {
      if (!db.get('SELECT id FROM contacts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId)) throw notFound('Kontakt nicht gefunden');
      recomputeContact(ctx.locationId, ctx.params.id, 'Manuell neu berechnet');
      return contactScores(ctx.locationId, ctx.params.id);
    });
    /** Scores of the primary model for a list of contacts (list column). */
    router.get('/api/lead-scoring/scores', 'location', (ctx) => {
      const ids = String(ctx.query.get('ids') ?? '').split(',').filter(Boolean).slice(0, 500);
      if (!ids.length) return {};
      const rows = db.all(
        `SELECT s.contact_id, s.score, s.label FROM lead_scores s JOIN lead_score_models m ON m.id = s.model_id AND m.is_primary = 1 WHERE m.location_id = ? AND s.contact_id IN (${ids.map(() => '?').join(',')})`,
        ctx.locationId,
        ...ids,
      );
      return Object.fromEntries(rows.map((r) => [r.contact_id, { score: r.score, label: r.label }]));
    });

    // --- snapshots: the models (rules refer to field keys and tags, which travel along) ----------
    const part: SnapshotPart = {
      key: 'lead_score_models',
      export: (_app, loc, only) => (only ? [] : models(loc).map((m) => ({ name: m.name, active: m.active, is_primary: m.is_primary, rules: m.rules, thresholds: m.thresholds, decay: m.decay, max_score: m.max_score }))),
      apply: (_app, loc, items, ctx) => {
        let n = 0;
        let hasPrimary = !!db.get('SELECT 1 FROM lead_score_models WHERE location_id = ? AND is_primary = 1', loc);
        for (const it of items.slice(0, 10)) {
          let cfg: ScoreModel;
          try {
            cfg = cleanModel(it, () => id(8));
          } catch {
            continue;
          }
          const primary = !hasPrimary && (it.is_primary || n === items.length - 1);
          if (primary) hasPrimary = true;
          // Dirty: the scheduler scores the new sub-account's contacts once it has some.
          db.insert('lead_score_models', { id: id(), location_id: loc, name: String(it.name ?? 'Lead-Score').slice(0, 80), active: it.active === false ? 0 : 1, is_primary: primary ? 1 : 0, rules: cfg.rules, thresholds: cfg.thresholds, decay: cfg.decay, max_score: cfg.max_score, dirty: 1, created_at: now(), updated_at: now() });
          n++;
        }
        ctx.created.lead_score_models = n;
      },
    };
    app.services.snapshotParts = [...(app.services.snapshotParts ?? []), part];

    // --- MCP --------------------------------------------------------------------------------------------
    const TOOLS: Tool[] = [
      {
        name: 'ghl_lead_score',
        title: 'Lead-Score eines Kontakts',
        description: 'Lead-Score(s) eines Kontakts mit Schwelle (z. B. MQL/SQL), Aufschlüsselung je Kriterium und Verlauf. Kontakt per contact_id oder email.',
        inputSchema: { type: 'object', properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID' }, contact_id: { type: 'string' }, email: { type: 'string' } }, required: ['location_id'], additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
        run: async (call, a) => {
          let cid = a.contact_id;
          if (!cid && a.email) cid = (await call.api('GET', `/api/contacts?q=${encodeURIComponent(a.email)}&limit=1`, { location: a.location_id })).contacts?.[0]?.id;
          if (!cid) throw bad('Kontakt nicht gefunden (contact_id oder email)');
          return call.api('GET', `/api/lead-scoring/contacts/${encodeURIComponent(cid)}`, { location: a.location_id });
        },
      },
    ];
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
