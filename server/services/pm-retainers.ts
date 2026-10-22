import type { App } from '../core/app.js';
import { HttpError, bad, notFound, str } from '../core/http.js';
import { id as newId, now } from '../core/util.js';
import { createInvoice } from '../modules/payments.js';
import { isDraftNumber } from './invoice-model.js';
import { ROLLOVERS, addMonths, isMonth, monthDays, monthLabel, retainerLines, retainerPeriod, round2, type PeriodResult, type Rollover } from './pm-costing-model.js';
import type { RetainerFacts } from './pm-costing.js';
import { dayOf, getProject, getSettings, projectContact, todayIn, tzOf, type Actor, type ProjectRow } from './pm-core.js';
import { addDays } from './pm-schedule.js';
import { billedSeconds, type TimeRow } from './pm-time.js';

/**
 * Retainers (docs/projects.md#retainers): a monthly hour contingent for a client or one project at a fixed price, with a carry-over
 * rule (none / up to N hours / unlimited) and an overage rate. Closing a month counts the billable time of the month, works out the
 * carry-over and the overage (pm-costing-model.ts) and makes an invoice draft with the invoices module – the fee plus the overage.
 * The month's time entries then point at that invoice, so they cannot be billed a second time; cancelling the invoice frees them
 * (pm-time.ts) and the month can be closed again.
 */

export interface RetainerRow {
  id: string;
  location_id: string;
  name: string;
  contact_id: string | null;
  project_id: string | null;
  hours_per_month: number;
  price_cents: number;
  overage_rate_cents: number;
  rollover: Rollover;
  rollover_max_hours: number;
  start_month: string;
  end_month: string | null;
  status: 'active' | 'ended';
  auto_close: number;
  tax_rate: number | null;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PeriodRow extends PeriodResult {
  id: string;
  location_id: string;
  retainer_id: string;
  month: string;
  price_cents: number;
  overage_rate_cents: number;
  invoice_id: string | null;
  entries: number;
  closed_by: string | null;
  closed_at: string;
}

const retainerRow = (app: App, loc: string, rid: string): RetainerRow => {
  const r = app.db.get<RetainerRow>('SELECT * FROM pm_retainers WHERE id = ? AND location_id = ?', String(rid ?? ''), loc);
  if (!r) throw notFound('Retainer nicht gefunden');
  return r;
};

const num = (v: unknown, label: string, min: number, max: number): number => {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min || n > max) throw bad(`${label}: Zahl zwischen ${min} und ${max}`);
  return n;
};
const centsOf = (v: unknown, label: string) => Math.round(num(v, label, 0, 100_000_000_00));

const thisMonth = (app: App, loc: string) => todayIn(tzOf(app, loc)).slice(0, 7);

function cleanRetainer(app: App, loc: string, b: any, cur?: RetainerRow) {
  const out: Partial<RetainerRow> = {};
  if (b.name !== undefined || !cur) out.name = str(b.name, 'Name', { required: true, max: 120 });
  if (b.project_id !== undefined) out.project_id = b.project_id ? getProject(app, loc, String(b.project_id)).id : null;
  if (b.contact_id !== undefined) {
    out.contact_id = b.contact_id ? String(b.contact_id) : null;
    if (out.contact_id && !app.db.get('SELECT 1 AS x FROM contacts WHERE id = ? AND location_id = ?', out.contact_id, loc)) throw bad('Kontakt nicht gefunden');
  }
  if (b.hours_per_month !== undefined || !cur) out.hours_per_month = round2(num(b.hours_per_month, 'Stunden pro Monat', 0.25, 744));
  if (b.price_cents !== undefined || !cur) out.price_cents = centsOf(b.price_cents, 'Preis pro Monat');
  if (b.overage_rate_cents !== undefined) out.overage_rate_cents = centsOf(b.overage_rate_cents || 0, 'Satz für Mehrstunden');
  if (b.rollover !== undefined) {
    if (!(ROLLOVERS as readonly string[]).includes(b.rollover)) throw bad('Übertrag: none, capped oder unlimited');
    out.rollover = b.rollover;
  }
  if (b.rollover_max_hours !== undefined) out.rollover_max_hours = round2(num(b.rollover_max_hours || 0, 'Höchster Übertrag', 0, 10_000));
  if (b.start_month !== undefined || !cur) {
    const m = b.start_month ? String(b.start_month) : thisMonth(app, loc);
    if (!isMonth(m)) throw bad('Startmonat als JJJJ-MM');
    out.start_month = m;
  }
  if (b.end_month !== undefined) {
    out.end_month = b.end_month ? String(b.end_month) : null;
    if (out.end_month && !isMonth(out.end_month)) throw bad('Endmonat als JJJJ-MM');
  }
  if (b.status !== undefined) {
    if (!['active', 'ended'].includes(b.status)) throw bad('Status: active oder ended');
    out.status = b.status;
  }
  if (b.auto_close !== undefined) out.auto_close = b.auto_close ? 1 : 0;
  if (b.tax_rate !== undefined) out.tax_rate = b.tax_rate === null || b.tax_rate === '' ? null : num(b.tax_rate, 'Steuersatz', 0, 100);
  if (b.notes !== undefined) out.notes = str(b.notes, 'Hinweise', { max: 2000 });
  const next = { ...cur, ...out } as RetainerRow;
  if (next.end_month && next.end_month < next.start_month) throw bad('Der Endmonat liegt vor dem Startmonat');
  if (next.rollover === 'capped' && !(next.rollover_max_hours > 0)) throw bad('Für „Übertrag bis zu N Stunden“ bitte N angeben');
  // The invoice needs a customer: the contact, or the customer of the project.
  if (!next.contact_id && next.project_id) {
    const p = getProject(app, loc, next.project_id);
    out.contact_id = projectContact(app, loc, p);
  }
  if (!next.contact_id && !out.contact_id) throw bad('Kunde fehlt: Kontakt wählen oder ein Projekt mit Kunde');
  return out;
}

export function createRetainer(app: App, loc: string, b: any, actor: Actor): RetainerRow {
  const clean = cleanRetainer(app, loc, b);
  const t = now();
  const row: RetainerRow = {
    id: newId(),
    location_id: loc,
    name: clean.name!,
    contact_id: clean.contact_id ?? null,
    project_id: clean.project_id ?? null,
    hours_per_month: clean.hours_per_month!,
    price_cents: clean.price_cents!,
    overage_rate_cents: clean.overage_rate_cents ?? 0,
    rollover: clean.rollover ?? 'none',
    rollover_max_hours: clean.rollover_max_hours ?? 0,
    start_month: clean.start_month!,
    end_month: clean.end_month ?? null,
    status: clean.status ?? 'active',
    auto_close: clean.auto_close ?? 0,
    tax_rate: clean.tax_rate ?? null,
    notes: clean.notes ?? '',
    created_by: actor.id,
    created_at: t,
    updated_at: t,
  };
  if (row.project_id && app.db.get(`SELECT 1 AS x FROM pm_retainers WHERE location_id = ? AND project_id = ? AND status = 'active'`, loc, row.project_id)) throw bad('Für dieses Projekt läuft schon ein Retainer');
  app.db.insert('pm_retainers', row);
  return row;
}

export function updateRetainer(app: App, loc: string, rid: string, b: any): RetainerRow {
  const cur = retainerRow(app, loc, rid);
  const clean = cleanRetainer(app, loc, b, cur);
  if (clean.start_month && clean.start_month !== cur.start_month && validPeriods(app, loc, cur.id).length) throw bad('Der Startmonat lässt sich nach dem ersten abgeschlossenen Monat nicht mehr ändern');
  if (Object.keys(clean).length) app.db.update('pm_retainers', cur.id, { ...clean, updated_at: now() }, loc);
  return retainerRow(app, loc, cur.id);
}

export function deleteRetainer(app: App, loc: string, rid: string) {
  const r = retainerRow(app, loc, rid);
  if (app.db.get('SELECT 1 AS x FROM pm_retainer_periods WHERE retainer_id = ?', r.id)) throw new HttpError(409, 'Dieser Retainer hat abgeschlossene Monate – bitte beenden statt löschen');
  app.db.run('DELETE FROM pm_retainers WHERE id = ? AND location_id = ?', r.id, loc);
  return { ok: true };
}

// --- periods --------------------------------------------------------------------------------------------------------------------------

/** The invoices of these ids that still count (not cancelled, not deleted). */
function liveInvoices(app: App, loc: string, ids: string[]): Set<string> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  return new Set(app.db.all<{ id: string }>(`SELECT id FROM invoices WHERE location_id = ? AND status != 'void' AND id IN (${list.map(() => '?').join(',')})`, loc, ...list).map((r) => r.id));
}

const periodsOf = (app: App, loc: string, rid: string) => app.db.all<PeriodRow>('SELECT * FROM pm_retainer_periods WHERE retainer_id = ? AND location_id = ? ORDER BY month', rid, loc);

/** Closed months whose invoice still stands (a cancelled or deleted invoice re-opens its month). */
function validPeriods(app: App, loc: string, rid: string): PeriodRow[] {
  const all = periodsOf(app, loc, rid);
  const live = liveInvoices(app, loc, all.map((p) => p.invoice_id ?? ''));
  return all.filter((p) => p.invoice_id && live.has(p.invoice_id));
}

/** Projects whose time a retainer covers: its project, or every project of its client. */
export function scopeProjects(app: App, loc: string, r: Pick<RetainerRow, 'project_id' | 'contact_id'>): string[] {
  if (r.project_id) return [r.project_id];
  if (!r.contact_id) return [];
  return app.db
    .all<ProjectRow>('SELECT * FROM pm_projects WHERE location_id = ?', loc)
    .filter((p) => projectContact(app, loc, p) === r.contact_id)
    .map((p) => p.id);
}

/** The next month to close: after the last closed one (or the start month); null when none is due (yet). */
export function nextMonth(app: App, loc: string, r: RetainerRow): { month: string | null; due: boolean } {
  const valid = validPeriods(app, loc, r.id);
  const month = valid.length ? addMonths(valid[valid.length - 1].month, 1) : r.start_month;
  if (r.end_month && month > r.end_month) return { month: null, due: false };
  return { month, due: month < thisMonth(app, loc) };
}

/** Billable, finished time of a month in the retainer's projects that is not on another invoice yet. */
function monthEntries(app: App, loc: string, r: RetainerRow, month: string, freeInvoices: string[] = []): TimeRow[] {
  const projects = scopeProjects(app, loc, r);
  if (!projects.length) return [];
  const [first, last] = monthDays(month);
  const free = freeInvoices.filter(Boolean);
  const rows = app.db.all<TimeRow>(
    `SELECT * FROM pm_time_entries WHERE location_id = ? AND billable = 1 AND ended_at IS NOT NULL AND project_id IN (${projects.map(() => '?').join(',')})
       AND (invoice_id IS NULL${free.length ? ` OR invoice_id IN (${free.map(() => '?').join(',')})` : ''}) AND started_at >= ? AND started_at < ? ORDER BY started_at`,
    loc,
    ...projects,
    ...free,
    `${addDays(first, -1)}T00:00:00.000Z`,
    `${addDays(last, 2)}T00:00:00.000Z`,
  );
  const tz = tzOf(app, loc);
  return rows.filter((e) => (dayOf(e.started_at, tz) ?? '').slice(0, 7) === month);
}

export interface PeriodPreview extends PeriodResult {
  month: string;
  label: string;
  due: boolean;
  entries: number;
  unapproved_hours: number;
  lines: ReturnType<typeof retainerLines>;
  net_cents: number;
}

/** What closing the month would do (or does, for the running month: the use so far). */
export function previewMonth(app: App, loc: string, r: RetainerRow, month: string): PeriodPreview {
  const settings = getSettings(app, loc);
  const all = periodsOf(app, loc, r.id);
  const valid = validPeriods(app, loc, r.id);
  const before = valid.filter((p) => p.month < month);
  const carryIn = before.length ? before[before.length - 1].carry_out_hours : 0;
  // Entries of a month whose invoice was cancelled are free again even if pm-time did not see the cancellation (Stornorechnung).
  const freed = all.filter((p) => p.month === month && p.invoice_id && !valid.includes(p)).map((p) => p.invoice_id!);
  const entries = monthEntries(app, loc, r, month, freed);
  const counted = settings.approval_required ? entries.filter((e) => e.approval === 'approved') : entries;
  const unapproved = settings.approval_required ? entries.filter((e) => e.approval !== 'approved') : [];
  const used = counted.reduce((s, e) => s + billedSeconds(e.seconds, settings.round_up_minutes), 0) / 3600;
  const p = retainerPeriod({ included_hours: r.hours_per_month, carry_in_hours: carryIn, used_hours: used, rollover: r.rollover, rollover_max_hours: r.rollover_max_hours });
  const lines = retainerLines(r, p, month);
  return {
    ...p,
    month,
    label: monthLabel(month),
    due: month < thisMonth(app, loc),
    entries: counted.length,
    unapproved_hours: round2(unapproved.reduce((s, e) => s + e.seconds, 0) / 3600),
    lines,
    net_cents: lines.reduce((s, l) => s + Math.round(l.qty * l.price_cents), 0),
  };
}

export interface CloseResult {
  period: PeriodRow;
  invoice: { id: string; total_cents: number; subtotal_cents: number; status: string; contact_id: string | null };
}

/**
 * Closes the next due month: the invoice draft (fee + overage) through the invoices module, the period with its carry-over, and the
 * month's time entries marked as billed on that invoice. Months are closed in order and only once they are over.
 */
export function closeMonth(app: App, loc: string, rid: string, b: { month?: string; include_unapproved?: boolean }, actor: Actor): CloseResult {
  const r = retainerRow(app, loc, rid);
  const next = nextMonth(app, loc, r);
  if (!next.month) throw new HttpError(409, 'Für diesen Retainer ist kein Monat mehr offen');
  const month = b.month ? String(b.month) : next.month;
  if (!isMonth(month)) throw bad('Monat als JJJJ-MM');
  if (month !== next.month) throw new HttpError(409, `Monate werden der Reihe nach abgeschlossen – zuerst ${monthLabel(next.month)}`);
  if (!next.due) throw new HttpError(409, `${monthLabel(month)} ist noch nicht vorbei`);
  const contactId = r.contact_id ?? (r.project_id ? projectContact(app, loc, getProject(app, loc, r.project_id)) : null);
  if (!contactId) throw bad('Der Retainer hat keinen Kunden – bitte einen Kontakt hinterlegen');
  const settings = getSettings(app, loc);
  const preview = previewMonth(app, loc, r, month);
  if (preview.unapproved_hours > 0 && !b.include_unapproved) throw new HttpError(409, `In ${preview.label} sind noch ${String(preview.unapproved_hours).replace('.', ',')} Std. nicht freigegeben – erst freigeben oder ausdrücklich mitnehmen`);
  const all = periodsOf(app, loc, r.id);
  const valid = validPeriods(app, loc, r.id);
  const freed = all.filter((p) => p.month === month && p.invoice_id && !valid.includes(p)).map((p) => p.invoice_id!);
  const entries = monthEntries(app, loc, r, month, freed).filter((e) => !settings.approval_required || b.include_unapproved || e.approval === 'approved');
  const taxRate = r.tax_rate ?? settings.tax_rate;
  const items = preview.lines.map((l) => ({ ...l, ...(taxRate !== null && taxRate !== undefined ? { tax_rate: Number(taxRate) } : {}) }));
  const invoice = createInvoice(app, loc, { contact_id: contactId, title: `Retainer „${r.name}“ – ${preview.label}`.slice(0, 300), items, notes: r.notes, currency: 'EUR' });
  const t = now();
  const row: PeriodRow = {
    id: newId(),
    location_id: loc,
    retainer_id: r.id,
    month,
    included_hours: preview.included_hours,
    carry_in_hours: preview.carry_in_hours,
    available_hours: preview.available_hours,
    used_hours: preview.used_hours,
    overage_hours: preview.overage_hours,
    unused_hours: preview.unused_hours,
    carry_out_hours: preview.carry_out_hours,
    price_cents: r.price_cents,
    overage_rate_cents: r.overage_rate_cents,
    invoice_id: invoice.id,
    entries: entries.length,
    closed_by: actor.id,
    closed_at: t,
  };
  try {
    app.db.tx(() => {
      app.db.run('DELETE FROM pm_retainer_periods WHERE retainer_id = ? AND month = ?', r.id, month);
      app.db.insert('pm_retainer_periods', row);
      for (const e of entries) {
        app.db.run(
          `UPDATE pm_time_entries SET invoice_id = ?, billed_rate_cents = 0, billed_seconds = ?, billed_at = ?, updated_at = ? WHERE id = ? AND location_id = ? AND (invoice_id IS NULL${freed.length ? ` OR invoice_id IN (${freed.map(() => '?').join(',')})` : ''})`,
          invoice.id,
          billedSeconds(e.seconds, settings.round_up_minutes),
          t,
          t,
          e.id,
          loc,
          ...freed,
        );
      }
    });
  } catch (e) {
    app.db.run('DELETE FROM invoices WHERE id = ? AND location_id = ?', invoice.id, loc);
    throw e;
  }
  app.services.audit?.({ action: 'pm.retainer.close', actor: actor.name, userId: actor.id, locationId: loc, entityId: r.id, summary: `Retainer „${r.name}“ ${preview.label}: ${preview.used_hours} Std. genutzt, ${preview.overage_hours} Std. Mehrstunden, Übertrag ${preview.carry_out_hours} Std.` });
  app.events.emit(loc, 'retainer.closed', { contactId, retainerId: r.id, month, invoiceId: invoice.id, used_hours: preview.used_hours, overage_hours: preview.overage_hours, carry_out_hours: preview.carry_out_hours });
  return { period: row, invoice: { id: invoice.id, total_cents: invoice.total_cents, subtotal_cents: invoice.subtotal_cents, status: invoice.status, contact_id: invoice.contact_id } };
}

/** Retainers with automatic close: every month that is over is closed on the first tick after it (a few per run). */
export function autoCloseRetainers(app: App, max = 20, only?: Set<string>): number {
  let n = 0;
  for (const r of app.db.all<RetainerRow>(`SELECT * FROM pm_retainers WHERE status = 'active' AND auto_close = 1 LIMIT 500`)) {
    if (n >= max) break;
    if (only && !only.has(r.id)) continue;
    try {
      const next = nextMonth(app, r.location_id, r);
      if (!next.month || !next.due) continue;
      closeMonth(app, r.location_id, r.id, {}, { id: null, name: 'Automatischer Monatsabschluss', via: 'automation' });
      n++;
    } catch (e) {
      // Unapproved time, a missing customer …: left for a person; the reason is in the audit log once a day at most.
      const msg = (e as Error).message;
      const key = `retainer-auto:${r.id}:${todayIn('UTC')}`;
      if (!app.db.get('SELECT 1 AS x FROM pm_seen WHERE key = ?', key)) {
        app.db.run('INSERT OR IGNORE INTO pm_seen (key, at) VALUES (?, ?)', key, now());
        app.services.audit?.({ action: 'pm.retainer.auto_close_failed', actor: 'System', locationId: r.location_id, entityId: r.id, summary: msg.slice(0, 300) });
      }
    }
  }
  return n;
}

// --- reading --------------------------------------------------------------------------------------------------------------------------

function contactNameOf(app: App, loc: string, cid: string | null): string {
  if (!cid) return '';
  const c = app.db.get<any>('SELECT first_name, last_name, email FROM contacts WHERE id = ? AND location_id = ?', cid, loc);
  return c ? [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '' : '';
}

export function retainerOut(app: App, loc: string, r: RetainerRow, withPeriods = false) {
  const next = r.status === 'active' ? nextMonth(app, loc, r) : { month: null, due: false };
  const current = thisMonth(app, loc);
  const running = r.status === 'active' && current >= r.start_month && (!r.end_month || current <= r.end_month) ? previewMonth(app, loc, r, current) : null;
  const project = r.project_id ? app.db.get<{ name: string }>('SELECT name FROM pm_projects WHERE id = ? AND location_id = ?', r.project_id, loc) : undefined;
  const out: Record<string, unknown> = {
    ...r,
    auto_close: !!r.auto_close,
    contact_name: contactNameOf(app, loc, r.contact_id),
    project_name: project?.name ?? '',
    next_month: next.month,
    next_due: next.due,
    current: running ? { month: running.month, used_hours: running.used_hours, available_hours: running.available_hours, carry_in_hours: running.carry_in_hours, overage_hours: running.overage_hours } : null,
  };
  if (withPeriods) {
    const periods = periodsOf(app, loc, r.id);
    const ids = periods.map((p) => p.invoice_id ?? '');
    const invoices = new Map(periods.length ? app.db.all<{ id: string; number: string; status: string; subtotal_cents: number }>(`SELECT id, number, status, subtotal_cents FROM invoices WHERE location_id = ? AND id IN (${ids.map(() => '?').join(',')})`, loc, ...ids).map((i) => [i.id, i]) : []);
    out.periods = periods
      .map((p) => {
        const inv = p.invoice_id ? invoices.get(p.invoice_id) : undefined;
        return { ...p, label: monthLabel(p.month), void: !inv || inv.status === 'void', invoice: inv ? { id: inv.id, number: isDraftNumber(inv.number) ? '' : inv.number, status: inv.status, subtotal_cents: inv.subtotal_cents } : null };
      })
      .reverse();
  }
  return out;
}

export function listRetainers(app: App, loc: string, f: { project_id?: string; contact_id?: string; status?: string }) {
  const where = ['location_id = ?'];
  const params: any[] = [loc];
  if (f.project_id) (where.push('project_id = ?'), params.push(f.project_id));
  if (f.contact_id) (where.push('contact_id = ?'), params.push(f.contact_id));
  if (f.status === 'active' || f.status === 'ended') (where.push('status = ?'), params.push(f.status));
  return app.db.all<RetainerRow>(`SELECT * FROM pm_retainers WHERE ${where.join(' AND ')} ORDER BY status, name LIMIT 500`, ...params).map((r) => retainerOut(app, loc, r));
}

export const getRetainer = (app: App, loc: string, rid: string) => retainerOut(app, loc, retainerRow(app, loc, rid), true);

export function previewRetainer(app: App, loc: string, rid: string, month?: string) {
  const r = retainerRow(app, loc, rid);
  const m = month || nextMonth(app, loc, r).month || thisMonth(app, loc);
  if (!isMonth(m)) throw bad('Monat als JJJJ-MM');
  return previewMonth(app, loc, r, m);
}

/** What the profitability report needs to know about retainers (pm-costing.ts). */
export function retainerFacts(app: App, loc: string): RetainerFacts {
  const retainers = app.db.all<RetainerRow>('SELECT * FROM pm_retainers WHERE location_id = ?', loc);
  const byId = new Map(retainers.map((r) => [r.id, r]));
  const periods = app.db.all<PeriodRow>('SELECT * FROM pm_retainer_periods WHERE location_id = ? AND invoice_id IS NOT NULL', loc);
  const invoiceIds = new Set(periods.map((p) => p.invoice_id!));
  const covered = new Map<string, string>();
  for (const r of retainers) {
    if (r.status !== 'active') continue;
    for (const pid of scopeProjects(app, loc, r)) if (!covered.has(pid) || covered.get(pid)! > r.start_month) covered.set(pid, r.start_month);
  }
  return {
    invoiceIds,
    covered,
    periods: periods.filter((p) => byId.has(p.retainer_id)).map((p) => ({ retainer_id: p.retainer_id, name: byId.get(p.retainer_id)!.name, project_id: byId.get(p.retainer_id)!.project_id, contact_id: byId.get(p.retainer_id)!.contact_id, month: p.month, invoice_id: p.invoice_id! })),
  };
}
