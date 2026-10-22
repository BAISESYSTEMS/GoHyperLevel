import type { App } from '../core/app.js';
import { bad, notFound, str } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { membersWhere, notifyMember } from './member-notify.js';
import { DEFAULT_THRESHOLDS, budgetState, burndown, cleanThresholds, margin, percentOf, round1, round2, thresholdChanges, timeCost } from './pm-costing-model.js';
import { dayOf, getProject, getSettings, isTeamMember, json, projectContact, team, todayIn, tzOf, type Actor, type ProjectRow } from './pm-core.js';
import { addDays } from './pm-schedule.js';
import { billedSeconds, type TimeRow } from './pm-time.js';

/**
 * Job costing on top of the time tracking (docs/projects.md#job-costing-and-retainers): internal cost rates per person, external
 * costs per project (optionally linked to a receipt of the bookkeeping), project budgets in hours and/or money with alert
 * thresholds, and the profitability report (revenue invoiced + unbilled billable, cost, margin) per project or client.
 * Retainers live in pm-retainers.ts; the pure maths in pm-costing-model.ts.
 */

const tableExists = (app: App, name: string) => !!app.db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?`, name);

const cents = (v: unknown, label: string, { min = 0, max = 100_000_000_00 }: { min?: number; max?: number } = {}): number => {
  const n = Math.round(Number(v));
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max) throw bad(`${label}: Betrag in Cent erwartet`);
  return n;
};
const ymdOr = (v: unknown, fallback: string, label: string): string => {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw bad(`${label}: Datum als JJJJ-MM-TT`);
  return s;
};

// --- cost rates ----------------------------------------------------------------------------------------------------------------------

export function costSettings(app: App, loc: string): { default_cost_cents: number } {
  const r = app.db.get<{ default_cost_cents: number }>('SELECT default_cost_cents FROM pm_cost_settings WHERE location_id = ?', loc);
  return { default_cost_cents: r?.default_cost_cents ?? 0 };
}

export function saveCostSettings(app: App, loc: string, b: any) {
  const v = cents(b.default_cost_cents ?? 0, 'Standard-Kostensatz', { max: 10_000_000 });
  app.db.run('INSERT INTO pm_cost_settings (location_id, default_cost_cents, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET default_cost_cents = excluded.default_cost_cents, updated_at = excluded.updated_at', loc, v, now());
  return costSettings(app, loc);
}

/** Internal cost rate per person (what an hour costs you – salary, overhead), next to the bill rate. */
export function listCostRates(app: App, loc: string) {
  const rates = new Map(app.db.all<{ user_id: string; cost_cents: number }>('SELECT user_id, cost_cents FROM pm_cost_rates WHERE location_id = ?', loc).map((r) => [r.user_id, r.cost_cents]));
  return { ...costSettings(app, loc), people: team(app, loc).map((p) => ({ user_id: p.id, name: p.name, cost_cents: rates.get(p.id) ?? null })) };
}

export function setCostRate(app: App, loc: string, b: any) {
  const userId = str(b.user_id, 'Person', { required: true, max: 64 });
  if (!isTeamMember(app, loc, userId)) throw bad('Nutzer nicht gefunden oder ohne Zugriff');
  if (b.cost_cents === null || b.cost_cents === '') {
    app.db.run('DELETE FROM pm_cost_rates WHERE location_id = ? AND user_id = ?', loc, userId);
    return { ok: true, removed: true };
  }
  const v = cents(b.cost_cents, 'Kostensatz', { max: 10_000_000 });
  app.db.run(
    'INSERT INTO pm_cost_rates (id, location_id, user_id, cost_cents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(location_id, user_id) DO UPDATE SET cost_cents = excluded.cost_cents, updated_at = excluded.updated_at',
    newId(),
    loc,
    userId,
    v,
    now(),
    now(),
  );
  return { ok: true, cost_cents: v };
}

/** Cost per hour of a person: own rate, else the sub-account default (0 = unknown). */
function costResolver(app: App, loc: string): { of: (userId: string) => number; known: (userId: string) => boolean } {
  const rates = new Map(app.db.all<{ user_id: string; cost_cents: number }>('SELECT user_id, cost_cents FROM pm_cost_rates WHERE location_id = ?', loc).map((r) => [r.user_id, r.cost_cents]));
  const def = costSettings(app, loc).default_cost_cents;
  return { of: (u) => rates.get(u) ?? def, known: (u) => rates.has(u) || def > 0 };
}

/** Bill rate per entry – the same order as rateFor in pm-time.ts (entry → person on project → project → person → default), read once. */
export function rateResolver(app: App, loc: string, projects: Map<string, ProjectRow>) {
  const pu = new Map<string, number>();
  const pers = new Map<string, number>();
  for (const r of app.db.all<{ project_id: string | null; user_id: string; rate_cents: number }>('SELECT project_id, user_id, rate_cents FROM pm_rates WHERE location_id = ?', loc)) {
    if (r.project_id) pu.set(`${r.project_id}|${r.user_id}`, r.rate_cents);
    else pers.set(r.user_id, r.rate_cents);
  }
  const def = getSettings(app, loc).default_rate_cents;
  return (userId: string, projectId: string | null, entryRate?: number | null): number => {
    if (entryRate !== null && entryRate !== undefined) return entryRate;
    if (projectId) {
      const a = pu.get(`${projectId}|${userId}`);
      if (a !== undefined) return a;
      const p = projects.get(projectId)?.hourly_rate_cents;
      if (p !== null && p !== undefined) return p;
    }
    return pers.get(userId) ?? def;
  };
}

// --- external costs ------------------------------------------------------------------------------------------------------------------

export interface CostRow {
  id: string;
  location_id: string;
  project_id: string;
  day: string;
  description: string;
  category: string;
  amount_cents: number;
  receipt_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const costRow = (app: App, loc: string, cid: string): CostRow => {
  const r = app.db.get<CostRow>('SELECT * FROM pm_costs WHERE id = ? AND location_id = ?', String(cid ?? ''), loc);
  if (!r) throw notFound('Kosten nicht gefunden');
  return r;
};

/** A receipt of the bookkeeping (acc_receipts) of this sub-account, if the module is there. */
function receiptOf(app: App, loc: string, rid: string) {
  if (!tableExists(app, 'acc_receipts')) throw bad('Die Buchhaltung ist nicht eingerichtet');
  const r = app.db.get<{ id: string; supplier: string; invoice_no: string; invoice_date: string | null; net_cents: number | null; gross_cents: number | null; status: string }>(
    'SELECT id, supplier, invoice_no, invoice_date, net_cents, gross_cents, status FROM acc_receipts WHERE id = ? AND location_id = ?',
    rid,
    loc,
  );
  if (!r) throw bad('Beleg nicht gefunden');
  return r;
}

export function listCosts(app: App, loc: string, f: { project_id?: string; from?: string; to?: string; limit?: number }) {
  const where = ['c.location_id = ?'];
  const params: any[] = [loc];
  if (f.project_id) (where.push('c.project_id = ?'), params.push(f.project_id));
  if (f.from) (where.push('c.day >= ?'), params.push(f.from));
  if (f.to) (where.push('c.day <= ?'), params.push(f.to));
  const rows = app.db.all<CostRow & { project_name: string }>(`SELECT c.*, p.name AS project_name FROM pm_costs c JOIN pm_projects p ON p.id = c.project_id WHERE ${where.join(' AND ')} ORDER BY c.day DESC, c.created_at DESC LIMIT ?`, ...params, Math.min(Math.max(Number(f.limit) || 500, 1), 2000));
  const receipts = new Map<string, { supplier: string; invoice_no: string }>();
  const ids = rows.map((r) => r.receipt_id).filter(Boolean) as string[];
  if (ids.length && tableExists(app, 'acc_receipts')) for (const r of app.db.all<any>(`SELECT id, supplier, invoice_no FROM acc_receipts WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, loc, ...ids)) receipts.set(r.id, r);
  return rows.map((r) => ({ ...r, receipt: r.receipt_id ? (receipts.get(r.receipt_id) ?? null) : null }));
}

export function addCost(app: App, loc: string, b: any, actor: Actor) {
  const project = getProject(app, loc, str(b.project_id, 'Projekt', { required: true, max: 64 }));
  const tz = tzOf(app, loc);
  let receipt: ReturnType<typeof receiptOf> | undefined;
  if (b.receipt_id) {
    receipt = receiptOf(app, loc, String(b.receipt_id));
    if (app.db.get('SELECT 1 AS x FROM pm_costs WHERE location_id = ? AND receipt_id = ?', loc, receipt.id)) throw bad('Dieser Beleg hängt schon an einem Projekt');
  }
  const amount = b.amount_cents !== undefined && b.amount_cents !== '' ? cents(b.amount_cents, 'Betrag') : receipt ? (receipt.net_cents ?? receipt.gross_cents ?? 0) : cents(b.amount_cents, 'Betrag');
  const description = str(b.description, 'Beschreibung', { max: 300 }) || (receipt ? [receipt.supplier, receipt.invoice_no].filter(Boolean).join(' ') : '');
  if (!description) throw bad('Beschreibung fehlt');
  const row: CostRow = {
    id: newId(),
    location_id: loc,
    project_id: project.id,
    day: ymdOr(b.day, receipt?.invoice_date?.slice(0, 10) || todayIn(tz), 'Datum'),
    description,
    category: str(b.category, 'Kategorie', { max: 80 }),
    amount_cents: amount,
    receipt_id: receipt?.id ?? null,
    created_by: actor.id,
    created_at: now(),
    updated_at: now(),
  };
  app.db.insert('pm_costs', row);
  return row;
}

export function updateCost(app: App, loc: string, cid: string, b: any, who: { id: string | null; manager: boolean }) {
  const r = costRow(app, loc, cid);
  if (!who.manager && r.created_by !== who.id) throw bad('Nur eigene Kosten bearbeiten – oder als Leitung');
  const patch: Record<string, any> = {};
  if (b.description !== undefined) patch.description = str(b.description, 'Beschreibung', { required: true, max: 300 });
  if (b.category !== undefined) patch.category = str(b.category, 'Kategorie', { max: 80 });
  if (b.amount_cents !== undefined) patch.amount_cents = cents(b.amount_cents, 'Betrag');
  if (b.day !== undefined) patch.day = ymdOr(b.day, r.day, 'Datum');
  if (b.project_id !== undefined) patch.project_id = getProject(app, loc, String(b.project_id)).id;
  if (!Object.keys(patch).length) return r;
  app.db.update('pm_costs', r.id, { ...patch, updated_at: now() }, loc);
  return costRow(app, loc, r.id);
}

export function deleteCost(app: App, loc: string, cid: string, who: { id: string | null; manager: boolean }) {
  const r = costRow(app, loc, cid);
  if (!who.manager && r.created_by !== who.id) throw bad('Nur eigene Kosten löschen – oder als Leitung');
  app.db.run('DELETE FROM pm_costs WHERE id = ? AND location_id = ?', r.id, loc);
  return { ok: true, project_id: r.project_id };
}

/** Receipts of the bookkeeping that are not linked to a project yet (newest first). */
export function linkableReceipts(app: App, loc: string, q = '') {
  if (!tableExists(app, 'acc_receipts')) return [];
  const like = `%${q.trim().slice(0, 60)}%`;
  return app.db.all<any>(
    `SELECT r.id, r.supplier, r.invoice_no, r.invoice_date, r.net_cents, r.gross_cents, r.currency, r.status FROM acc_receipts r
     WHERE r.location_id = ? AND r.status != 'inbox' AND (r.supplier LIKE ? OR r.invoice_no LIKE ?)
       AND NOT EXISTS (SELECT 1 FROM pm_costs c WHERE c.location_id = r.location_id AND c.receipt_id = r.id)
     ORDER BY COALESCE(r.invoice_date, r.created_at) DESC LIMIT 50`,
    loc,
    like,
    like,
  );
}

// --- budgets -------------------------------------------------------------------------------------------------------------------------

export interface BudgetRow {
  id: string;
  location_id: string;
  project_id: string;
  hours: number | null;
  amount_cents: number | null;
  include_costs: number;
  thresholds: string;
  notify: string;
  fired: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const budgetRowOf = (app: App, loc: string, projectId: string) => app.db.get<BudgetRow>('SELECT * FROM pm_budgets WHERE project_id = ? AND location_id = ?', projectId, loc);

export function saveBudget(app: App, loc: string, projectId: string, b: any, actor: Actor) {
  const project = getProject(app, loc, projectId);
  const cur = budgetRowOf(app, loc, project.id);
  const hours = b.hours === undefined ? (cur?.hours ?? null) : b.hours === null || b.hours === '' ? null : Number(b.hours);
  if (hours !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 1_000_000)) throw bad('Stunden-Budget: Zahl über 0');
  const amount = b.amount_cents === undefined ? (cur?.amount_cents ?? null) : b.amount_cents === null || b.amount_cents === '' ? null : cents(b.amount_cents, 'Budget', { min: 1 });
  if (hours === null && amount === null) throw bad('Stunden- oder Geld-Budget angeben (oder das Budget entfernen)');
  let thresholds: number[];
  try {
    thresholds = b.thresholds === undefined ? json<number[]>(cur?.thresholds, DEFAULT_THRESHOLDS) : cleanThresholds(b.thresholds);
  } catch (e) {
    throw bad((e as Error).message);
  }
  let notify: string[] = json<string[]>(cur?.notify, []);
  if (b.notify !== undefined) {
    if (!Array.isArray(b.notify)) throw bad('Benachrichtigen: Liste von Nutzer-IDs');
    notify = [...new Set(b.notify.map(String))].slice(0, 20) as string[];
    for (const u of notify) if (!isTeamMember(app, loc, u)) throw bad('Benachrichtigen: Nutzer nicht gefunden oder ohne Zugriff');
  }
  const includeCosts = b.include_costs === undefined ? (cur?.include_costs ?? 1) : b.include_costs ? 1 : 0;
  const t = now();
  if (cur) app.db.run('UPDATE pm_budgets SET hours = ?, amount_cents = ?, include_costs = ?, thresholds = ?, notify = ?, updated_at = ? WHERE id = ?', hours, amount, includeCosts, JSON.stringify(thresholds), JSON.stringify(notify), t, cur.id);
  else app.db.insert('pm_budgets', { id: newId(), location_id: loc, project_id: project.id, hours, amount_cents: amount, include_costs: includeCosts, thresholds: JSON.stringify(thresholds), notify: JSON.stringify(notify), fired: '{}', created_by: actor.id, created_at: t, updated_at: t });
  // A changed budget is checked at once: a lowered one may cross a threshold, a raised one re-arms them.
  checkBudget(app, loc, project.id);
  return budgetStatus(app, loc, project.id);
}

export function deleteBudget(app: App, loc: string, projectId: string) {
  const project = getProject(app, loc, projectId);
  app.db.run('DELETE FROM pm_budgets WHERE project_id = ? AND location_id = ?', project.id, loc);
  return { ok: true };
}

/** Finished entries of some projects (or all), optionally within days of the sub-account's zone. */
function entriesOf(app: App, loc: string, f: { projectIds?: string[]; from?: string; to?: string }): TimeRow[] {
  const where = ['location_id = ?', 'ended_at IS NOT NULL'];
  const params: any[] = [loc];
  if (f.projectIds) {
    if (!f.projectIds.length) return [];
    where.push(`project_id IN (${f.projectIds.map(() => '?').join(',')})`);
    params.push(...f.projectIds);
  }
  if (f.from) (where.push('started_at >= ?'), params.push(`${addDays(f.from, -1)}T00:00:00.000Z`));
  if (f.to) (where.push('started_at < ?'), params.push(`${addDays(f.to, 2)}T00:00:00.000Z`));
  const rows = app.db.all<TimeRow>(`SELECT * FROM pm_time_entries WHERE ${where.join(' AND ')} ORDER BY started_at LIMIT 50000`, ...params);
  if (!f.from && !f.to) return rows;
  const tz = tzOf(app, loc);
  return rows.filter((r) => {
    const d = dayOf(r.started_at, tz)!;
    return (!f.from || d >= f.from) && (!f.to || d <= f.to);
  });
}

/** Invoices that count: id → net amount and whether it is cancelled (void) or gone. */
function invoiceState(app: App, loc: string, ids: string[]): Map<string, { void: boolean; subtotal_cents: number; status: string; number: string }> {
  const out = new Map<string, { void: boolean; subtotal_cents: number; status: string; number: string }>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 500) {
    const part = uniq.slice(i, i + 500);
    for (const r of app.db.all<{ id: string; status: string; subtotal_cents: number; number: string }>(`SELECT id, status, subtotal_cents, number FROM invoices WHERE location_id = ? AND id IN (${part.map(() => '?').join(',')})`, loc, ...part)) {
      out.set(r.id, { void: r.status === 'void', subtotal_cents: r.subtotal_cents, status: r.status, number: r.number });
    }
  }
  return out;
}

/** Money value of a billable entry: what went on a (valid) invoice, else hours (rounded like billing) × the current bill rate. */
function feesOf(e: TimeRow, inv: Map<string, { void: boolean }>, rate: ReturnType<typeof rateResolver>, roundMinutes: number): number {
  if (!e.billable) return 0;
  const billed = e.invoice_id && inv.has(e.invoice_id) && !inv.get(e.invoice_id)!.void;
  if (billed && e.billed_rate_cents && e.billed_seconds !== null) return Math.round((e.billed_seconds / 3600) * e.billed_rate_cents);
  return Math.round((billedSeconds(e.seconds, roundMinutes) / 3600) * rate(e.user_id, e.project_id, e.rate_cents));
}

/** What a project has used: hours (all logged time), fees (billable value, plus external costs if the budget counts them), cost. */
export function budgetUsage(app: App, loc: string, project: ProjectRow, includeCosts = true) {
  const projects = new Map([[project.id, project]]);
  const entries = entriesOf(app, loc, { projectIds: [project.id] });
  const inv = invoiceState(app, loc, entries.map((e) => e.invoice_id ?? ''));
  const rate = rateResolver(app, loc, projects);
  const round = getSettings(app, loc).round_up_minutes;
  const cost = costResolver(app, loc);
  const external = Number(app.db.get<{ s: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM pm_costs WHERE location_id = ? AND project_id = ?', loc, project.id)?.s ?? 0);
  let seconds = 0;
  let fees = 0;
  let timeCostCents = 0;
  for (const e of entries) {
    seconds += e.seconds;
    fees += feesOf(e, inv, rate, round);
    timeCostCents += timeCost(e.seconds, cost.of(e.user_id));
  }
  return { hours: round2(seconds / 3600), fees_cents: fees + (includeCosts ? external : 0), time_fees_cents: fees, external_cost_cents: external, cost_cents: timeCostCents + external };
}

export function budgetStatus(app: App, loc: string, projectId: string) {
  const project = getProject(app, loc, projectId);
  const b = budgetRowOf(app, loc, project.id);
  if (!b) return { project_id: project.id, budget: null };
  const thresholds = json<number[]>(b.thresholds, DEFAULT_THRESHOLDS);
  const usage = budgetUsage(app, loc, project, !!b.include_costs);
  const ph = percentOf(usage.hours, b.hours);
  const pa = percentOf(usage.fees_cents, b.amount_cents);
  return {
    project_id: project.id,
    budget: { hours: b.hours, amount_cents: b.amount_cents, include_costs: !!b.include_costs, thresholds, notify: json<string[]>(b.notify, []), updated_at: b.updated_at },
    used: { hours: usage.hours, amount_cents: usage.fees_cents, time_fees_cents: usage.time_fees_cents, external_cost_cents: usage.external_cost_cents },
    percent: { hours: ph, amount: pa },
    remaining: { hours: b.hours !== null ? round2(b.hours - usage.hours) : null, amount_cents: b.amount_cents !== null ? b.amount_cents - usage.fees_cents : null },
    fired: json<Record<string, number[]>>(b.fired, {}),
    state: budgetState([ph, pa], thresholds),
  };
}

/** Budgets of all projects of the sub-account with their state (for the overview). */
export function listBudgets(app: App, loc: string) {
  return app.db.all<{ project_id: string; name: string; color: string }>('SELECT b.project_id, p.name, p.color FROM pm_budgets b JOIN pm_projects p ON p.id = b.project_id WHERE b.location_id = ? ORDER BY p.name', loc).map((r) => ({ ...budgetStatus(app, loc, r.project_id), name: r.name, color: r.color }));
}

/** Leitung of a sub-account: agency admins and members with the settings area. */
export const managersOf = (app: App, loc: string) => membersWhere(app, loc, (u) => u.role === 'admin' || !u.permissions || u.permissions.includes('settings'));

const fmtHours = (h: number) => `${round2(h).toLocaleString('de-DE')} Std.`;
const fmtEur = (c: number) => `${(c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/**
 * Compares a project's use with its budget and fires every threshold reached for the first time: one notification (the highest
 * threshold) to the people chosen in the budget – or the project owner and the Leitung –, an audit line and one workflow event
 * `project.budget_threshold` per threshold. Each threshold fires once; it is armed again only when the use falls below it.
 */
export function checkBudget(app: App, loc: string, projectId: string): { kind: 'hours' | 'amount'; threshold: number; percent: number }[] {
  const b = budgetRowOf(app, loc, projectId);
  if (!b) return [];
  const project = app.db.get<ProjectRow>('SELECT * FROM pm_projects WHERE id = ? AND location_id = ?', projectId, loc);
  if (!project) return [];
  const thresholds = json<number[]>(b.thresholds, DEFAULT_THRESHOLDS);
  const usage = budgetUsage(app, loc, project, !!b.include_costs);
  const fired = json<Record<string, number[]>>(b.fired, {});
  const hits: { kind: 'hours' | 'amount'; threshold: number; percent: number; used: number; budget: number }[] = [];
  let changed = false;
  for (const kind of ['hours', 'amount'] as const) {
    const budget = kind === 'hours' ? b.hours : b.amount_cents;
    const used = kind === 'hours' ? usage.hours : usage.fees_cents;
    const pct = percentOf(used, budget);
    const { fire, reset } = thresholdChanges(pct, thresholds, fired[kind] ?? []);
    if (!fire.length && !reset.length) continue;
    changed = true;
    fired[kind] = [...(fired[kind] ?? []).filter((t) => !reset.includes(t)), ...fire].sort((x, y) => x - y);
    for (const t of fire) hits.push({ kind, threshold: t, percent: pct!, used, budget: budget! });
  }
  if (!changed) return [];
  // Claimed in one statement against the version read: a second check running for the same change finds nothing left to fire.
  const claimed = app.db.run('UPDATE pm_budgets SET fired = ? WHERE id = ? AND fired = ?', JSON.stringify(fired), b.id, b.fired).changes;
  if (!claimed || !hits.length) return [];
  const contactId = projectContact(app, loc, project);
  const explicit = json<string[]>(b.notify, []);
  const people = explicit.length ? explicit : [...new Set([...(project.owner_id ? [project.owner_id] : []), ...managersOf(app, loc)])];
  for (const kind of ['hours', 'amount'] as const) {
    const mine = hits.filter((h) => h.kind === kind);
    if (!mine.length) continue;
    const top = mine[mine.length - 1];
    const what = kind === 'hours' ? `${fmtHours(top.used)} von ${fmtHours(top.budget)}` : `${fmtEur(top.used)} von ${fmtEur(top.budget)}`;
    const title = `Budget „${project.name}“: ${String(round1(top.percent)).replace('.', ',')} % ${kind === 'hours' ? 'der Stunden' : 'des Budgets'} verbraucht`;
    const stamp = now().slice(0, 16);
    for (const u of people) notifyMember(app, { locationId: loc, userId: u, kind: 'budget', title, body: `${what} (Schwelle ${top.threshold} %)`, link: `/app/pm/${project.id}`, projectId: project.id, ref: `budget:${project.id}:${kind}:${top.threshold}:${stamp}`, area: kind === 'amount' ? 'payments' : 'contacts', push: 'payments' });
    app.services.audit?.({ action: 'pm.budget.threshold', actor: 'System', locationId: loc, entityId: project.id, summary: `${title} – ${what}` });
  }
  for (const h of hits) {
    app.events.emit(loc, 'project.budget_threshold', {
      ...(contactId ? { contactId } : {}),
      projectId: project.id,
      project: { id: project.id, name: project.name },
      kind: h.kind,
      threshold: h.threshold,
      percent: h.percent,
      used: h.used,
      budget: h.budget,
      unit: h.kind === 'hours' ? 'hours' : 'cents',
    });
  }
  return hits.map(({ kind, threshold, percent }) => ({ kind, threshold, percent }));
}

/** Every budget of every sub-account (the background check after edits that send no event: deleted entries, changed rates). */
export function checkAllBudgets(app: App): number {
  let n = 0;
  for (const r of app.db.all<{ location_id: string; project_id: string }>('SELECT location_id, project_id FROM pm_budgets LIMIT 5000')) n += checkBudget(app, r.location_id, r.project_id).length;
  return n;
}

// --- profitability -------------------------------------------------------------------------------------------------------------------

export interface ProfitRow {
  key: string;
  label: string;
  color?: string;
  project_id?: string | null;
  hours: number;
  billable_hours: number;
  revenue_invoiced_cents: number;
  revenue_unbilled_cents: number;
  revenue_retainer_open_hours: number;
  revenue_cents: number;
  time_cost_cents: number;
  external_cost_cents: number;
  cost_cents: number;
  margin_cents: number;
  margin_percent: number | null;
  missing_cost_rate: boolean;
  budget_state?: string;
}

export interface ProfitFilter {
  group?: string;
  from?: string;
  to?: string;
  project_id?: string;
}

/** The retainers' side for the report: invoices of closed months, and which projects' open time a running retainer covers. */
export interface RetainerFacts {
  /** Invoices made by retainer month closes (their time entries carry them; the fee counts, not the entries). */
  invoiceIds: Set<string>;
  /** Closed months with a valid invoice: net amount to count as revenue. */
  periods: { retainer_id: string; name: string; project_id: string | null; contact_id: string | null; month: string; invoice_id: string }[];
  /** Project → first month a running retainer covers its open time from. */
  covered: Map<string, string>;
}

/**
 * Revenue, cost and margin per project or client. Revenue = time on valid invoices (at the billed rate and rounded time) + fees of
 * closed retainer months + billable time not invoiced yet (hours rounded like billing × the current rate; time a running retainer
 * covers is left out until its month is closed). Cost = logged hours × internal cost rate + external costs. Days in the zone.
 */
export function profitability(app: App, loc: string, f: ProfitFilter, retainers: RetainerFacts) {
  const group = f.group === 'client' ? 'client' : 'project';
  const tz = tzOf(app, loc);
  const projects = new Map(app.db.all<ProjectRow>('SELECT * FROM pm_projects WHERE location_id = ?', loc).map((p) => [p.id, p]));
  const scope = f.project_id ? [getProject(app, loc, f.project_id).id] : undefined;
  const entries = entriesOf(app, loc, { projectIds: scope, from: f.from, to: f.to });
  const inv = invoiceState(app, loc, [...entries.map((e) => e.invoice_id ?? ''), ...retainers.periods.map((p) => p.invoice_id)]);
  const rate = rateResolver(app, loc, projects);
  const round = getSettings(app, loc).round_up_minutes;
  const cost = costResolver(app, loc);
  const contactNames = new Map<string, string>();
  const nameOfContact = (cid: string) => {
    if (!contactNames.has(cid)) {
      const c = app.db.get<any>('SELECT first_name, last_name, email FROM contacts WHERE id = ? AND location_id = ?', cid, loc);
      contactNames.set(cid, c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Kunde' : 'Kunde');
    }
    return contactNames.get(cid)!;
  };
  const clientCache = new Map<string, { key: string; label: string }>();
  const clientOf = (projectId: string | null): { key: string; label: string } => {
    const k = projectId ?? '-';
    if (clientCache.has(k)) return clientCache.get(k)!;
    const p = projectId ? projects.get(projectId) : undefined;
    let out = { key: '-', label: 'Ohne Kunde' };
    const cid = p ? projectContact(app, loc, p) : null;
    if (cid) out = { key: `c:${cid}`, label: nameOfContact(cid) };
    else if (p?.company_id) {
      const name = app.db.get<any>('SELECT name FROM companies WHERE id = ? AND location_id = ?', p.company_id, loc)?.name;
      if (name) out = { key: `co:${p.company_id}`, label: name };
    }
    clientCache.set(k, out);
    return out;
  };
  const rows = new Map<string, ProfitRow>();
  const rowOf = (key: string, label: string, extra: Partial<ProfitRow> = {}): ProfitRow => {
    let r = rows.get(key);
    if (!r) {
      r = { key, label, hours: 0, billable_hours: 0, revenue_invoiced_cents: 0, revenue_unbilled_cents: 0, revenue_retainer_open_hours: 0, revenue_cents: 0, time_cost_cents: 0, external_cost_cents: 0, cost_cents: 0, margin_cents: 0, margin_percent: null, missing_cost_rate: false, ...extra };
      rows.set(key, r);
    }
    return r;
  };
  const projectRow = (projectId: string | null) => {
    if (group === 'client') {
      const c = clientOf(projectId);
      return rowOf(c.key, c.label);
    }
    const p = projectId ? projects.get(projectId) : undefined;
    return rowOf(projectId ?? '-', p?.name ?? 'Ohne Projekt', { color: p?.color, project_id: projectId });
  };

  for (const e of entries) {
    const r = projectRow(e.project_id);
    r.hours += e.seconds / 3600;
    if (e.billable) r.billable_hours += e.seconds / 3600;
    const i = e.invoice_id ? inv.get(e.invoice_id) : undefined;
    if (i && !i.void) {
      if (!retainers.invoiceIds.has(e.invoice_id!) && e.billed_rate_cents && e.billed_seconds !== null) r.revenue_invoiced_cents += Math.round((e.billed_seconds / 3600) * e.billed_rate_cents);
    } else if (e.billable) {
      const from = e.project_id ? retainers.covered.get(e.project_id) : undefined;
      const day = dayOf(e.started_at, tz)!;
      if (from && day.slice(0, 7) >= from) r.revenue_retainer_open_hours += billedSeconds(e.seconds, round) / 3600;
      else r.revenue_unbilled_cents += Math.round((billedSeconds(e.seconds, round) / 3600) * rate(e.user_id, e.project_id, e.rate_cents));
    }
    r.time_cost_cents += timeCost(e.seconds, cost.of(e.user_id));
    if (!cost.known(e.user_id)) r.missing_cost_rate = true;
  }
  const fromMonth = f.from?.slice(0, 7);
  const toMonth = f.to?.slice(0, 7);
  for (const p of retainers.periods) {
    if ((fromMonth && p.month < fromMonth) || (toMonth && p.month > toMonth)) continue;
    if (scope && p.project_id !== scope[0]) continue;
    const i = inv.get(p.invoice_id);
    if (!i || i.void) continue;
    let r: ProfitRow;
    if (p.project_id && projects.has(p.project_id)) r = projectRow(p.project_id);
    else if (group === 'client') r = p.contact_id ? rowOf(`c:${p.contact_id}`, nameOfContact(p.contact_id)) : rowOf('-', 'Ohne Kunde');
    else r = rowOf(`r:${p.retainer_id}`, `Retainer „${p.name}“`);
    r.revenue_invoiced_cents += i.subtotal_cents;
  }
  const costWhere = ['location_id = ?'];
  const costParams: any[] = [loc];
  if (scope) (costWhere.push('project_id = ?'), costParams.push(scope[0]));
  if (f.from) (costWhere.push('day >= ?'), costParams.push(f.from));
  if (f.to) (costWhere.push('day <= ?'), costParams.push(f.to));
  for (const c of app.db.all<{ project_id: string; s: number }>(`SELECT project_id, SUM(amount_cents) AS s FROM pm_costs WHERE ${costWhere.join(' AND ')} GROUP BY project_id`, ...costParams)) projectRow(c.project_id).external_cost_cents += c.s;

  const budgets = group === 'project' ? new Map(app.db.all<{ project_id: string }>('SELECT project_id FROM pm_budgets WHERE location_id = ?', loc).map((b) => [b.project_id, true])) : new Map();
  const list = [...rows.values()].map((r) => {
    r.hours = round2(r.hours);
    r.billable_hours = round2(r.billable_hours);
    r.revenue_retainer_open_hours = round2(r.revenue_retainer_open_hours);
    r.revenue_cents = r.revenue_invoiced_cents + r.revenue_unbilled_cents;
    r.cost_cents = r.time_cost_cents + r.external_cost_cents;
    Object.assign(r, margin(r.revenue_cents, r.cost_cents));
    if (r.project_id && budgets.has(r.project_id)) r.budget_state = budgetStatus(app, loc, r.project_id).state;
    return r;
  });
  list.sort((a, b) => b.revenue_cents - a.revenue_cents || b.hours - a.hours);
  const sum = (k: keyof ProfitRow) => list.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const totals = {
    hours: round2(sum('hours')),
    billable_hours: round2(sum('billable_hours')),
    revenue_invoiced_cents: sum('revenue_invoiced_cents'),
    revenue_unbilled_cents: sum('revenue_unbilled_cents'),
    revenue_retainer_open_hours: round2(sum('revenue_retainer_open_hours')),
    revenue_cents: sum('revenue_cents'),
    time_cost_cents: sum('time_cost_cents'),
    external_cost_cents: sum('external_cost_cents'),
    cost_cents: sum('cost_cents'),
    ...margin(sum('revenue_cents'), sum('cost_cents')),
    missing_cost_rate: list.some((r) => r.missing_cost_rate),
  };
  return { group, from: f.from ?? null, to: f.to ?? null, rows: list, totals };
}

const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
const dec = (n: number) => n.toFixed(2).replace('.', ',');

export function profitCsv(report: ReturnType<typeof profitability>): string[][] {
  const head = [report.group === 'client' ? 'Kunde' : 'Projekt', 'Stunden', 'davon abrechenbar', 'Umsatz abgerechnet (EUR)', 'Umsatz offen (EUR)', 'Umsatz gesamt (EUR)', 'Kosten Zeit (EUR)', 'Fremdkosten (EUR)', 'Kosten gesamt (EUR)', 'Marge (EUR)', 'Marge (%)'];
  const line = (label: string, r: Omit<ProfitRow, 'key' | 'label'> | typeof report.totals) => [label, dec(r.hours), dec(r.billable_hours), money(r.revenue_invoiced_cents), money(r.revenue_unbilled_cents), money(r.revenue_cents), money(r.time_cost_cents), money(r.external_cost_cents), money(r.cost_cents), money(r.margin_cents), r.margin_percent === null ? '' : dec(r.margin_percent)];
  return [head, ...report.rows.map((r) => line(r.label, r)), line('Summe', report.totals)];
}

/** Remaining budget over time (hours and/or money) from the project's start (or first entry) until today. */
export function burndownOf(app: App, loc: string, projectId: string) {
  const project = getProject(app, loc, projectId);
  const b = budgetRowOf(app, loc, project.id);
  if (!b) return { project_id: project.id, budget: null };
  const tz = tzOf(app, loc);
  const today = todayIn(tz);
  const entries = entriesOf(app, loc, { projectIds: [project.id] });
  const inv = invoiceState(app, loc, entries.map((e) => e.invoice_id ?? ''));
  const rate = rateResolver(app, loc, new Map([[project.id, project]]));
  const round = getSettings(app, loc).round_up_minutes;
  const hours: { day: string; value: number }[] = [];
  const fees: { day: string; value: number }[] = [];
  for (const e of entries) {
    const day = dayOf(e.started_at, tz)!;
    hours.push({ day, value: e.seconds / 3600 });
    fees.push({ day, value: feesOf(e, inv, rate, round) / 100 });
  }
  if (b.include_costs) for (const c of app.db.all<{ day: string; amount_cents: number }>('SELECT day, amount_cents FROM pm_costs WHERE location_id = ? AND project_id = ?', loc, project.id)) fees.push({ day: c.day, value: c.amount_cents / 100 });
  const firstUse = [...hours, ...fees].map((u) => u.day).sort()[0];
  const start = [dayOf(project.start_at, tz), firstUse, b.created_at.slice(0, 10)].filter(Boolean).sort()[0] as string;
  const from = start > today ? today : start;
  const due = dayOf(project.due_at, tz);
  return {
    project_id: project.id,
    budget: { hours: b.hours, amount_cents: b.amount_cents },
    from,
    to: today,
    due,
    hours: b.hours !== null ? burndown(b.hours, hours, from, today, due) : null,
    amount: b.amount_cents !== null ? burndown(b.amount_cents / 100, fees, from, today, due) : null,
  };
}
