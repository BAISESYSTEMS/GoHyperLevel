import type { App } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { addDaysYmd, zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { q3, usersWithArea } from './bo-common.js';

/**
 * Stock of the Lager: articles with stock per storage place, an append-only movement log (goods receipt, goods issue,
 * transfer, correction, inventory count), moving-average cost (gleitender Durchschnittspreis, § 240 Abs. 4 HGB) and the
 * minimum-stock alert (once per drop: `stock.low` event + notification, re-armed when the stock is above the minimum again).
 */

export type MovementType = 'receipt' | 'issue' | 'transfer_out' | 'transfer_in' | 'correction' | 'count';
export const MOVEMENT_LABELS: Record<MovementType, string> = {
  receipt: 'Wareneingang',
  issue: 'Warenausgang',
  transfer_out: 'Umlagerung (ab)',
  transfer_in: 'Umlagerung (an)',
  correction: 'Korrektur',
  count: 'Inventur-Differenz',
};

export interface ArticleRow {
  id: string;
  location_id: string;
  sku: string;
  name: string;
  description: string;
  ean: string;
  unit: string;
  product_id: string | null;
  parent_id: string | null;
  variant: string;
  min_stock: number;
  reorder_qty: number;
  avg_cost_cents: number;
  last_cost_cents: number;
  supplier_contact_id: string | null;
  supplier_name: string;
  supplier_sku: string;
  track: number;
  auto_issue: number;
  default_place_id: string | null;
  low_notified: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface MovementIn {
  article_id: string;
  place_id?: string | null;
  type: MovementType;
  /** Positive amount; the sign comes from the type (correction and count may be negative). */
  qty: number;
  unit_cost_cents?: number | null;
  ref_type?: string;
  ref_id?: string;
  transfer_id?: string;
  note?: string;
  user_id?: string | null;
  allowNegative?: boolean;
}

export interface InvSettings {
  /** When invoices take articles out of stock: when paid, when sent/issued, or never. */
  auto_issue_on: 'paid' | 'sent' | 'off';
  /** Manual goods issues below zero (automatic ones may always go below zero, the alert shows it). */
  allow_negative: boolean;
}
export const defaultInvSettings = (): InvSettings => ({ auto_issue_on: 'paid', allow_negative: false });
export function getInvSettings(app: App, locationId: string): InvSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM inv_settings WHERE location_id = ?', locationId);
  let saved: any = {};
  try {
    saved = row ? JSON.parse(row.data) : {};
  } catch {
    saved = {};
  }
  const d = defaultInvSettings();
  return { auto_issue_on: ['paid', 'sent', 'off'].includes(saved.auto_issue_on) ? saved.auto_issue_on : d.auto_issue_on, allow_negative: saved.allow_negative === true };
}

const txn = <T>(app: App, fn: () => T): T => (app.db.raw.isTransaction ? fn() : app.db.tx(fn));

export const getArticle = (app: App, locationId: string, articleId: string): ArticleRow => {
  const a = app.db.get<ArticleRow>('SELECT * FROM inv_articles WHERE id = ? AND location_id = ?', articleId, locationId);
  if (!a) throw notFound('Artikel nicht gefunden');
  return a;
};

export function defaultPlace(app: App, locationId: string): string {
  const p = app.db.get<{ id: string }>('SELECT id FROM inv_places WHERE location_id = ? AND active = 1 ORDER BY is_default DESC, created_at LIMIT 1', locationId);
  if (p) return p.id;
  const pid = id();
  app.db.run(`INSERT INTO inv_places (id, location_id, name, code, is_default, active, created_at) VALUES (?, ?, 'Hauptlager', 'HL', 1, 1, ?)`, pid, locationId, now());
  return pid;
}

export const totalQty = (app: App, locationId: string, articleId: string): number => q3(app.db.get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) AS q FROM inv_stock WHERE location_id = ? AND article_id = ?', locationId, articleId)?.q ?? 0);
const placeQty = (app: App, articleId: string, placeId: string): number => app.db.get<{ qty: number }>('SELECT qty FROM inv_stock WHERE article_id = ? AND place_id = ?', articleId, placeId)?.qty ?? 0;

/**
 * Books one movement: stock per place, moving-average cost on receipts, the log entry, the low-stock check.
 * Throws German errors; nothing is written then.
 */
export function applyMovement(app: App, locationId: string, m: MovementIn): { id: string; balance: number; low: boolean; article: ArticleRow } {
  const qtyIn = q3(Number(m.qty));
  if (!Number.isFinite(qtyIn) || qtyIn === 0) throw bad('Menge muss ungleich 0 sein');
  if (Math.abs(qtyIn) > 1e9) throw bad('Menge zu groß');
  if ((m.type === 'receipt' || m.type === 'issue' || m.type === 'transfer_in' || m.type === 'transfer_out') && qtyIn < 0) throw bad('Menge muss größer als 0 sein');
  const signed = m.type === 'issue' || m.type === 'transfer_out' ? -qtyIn : qtyIn;
  return txn(app, () => {
    const a = getArticle(app, locationId, m.article_id);
    if (!a.active) throw bad(`Artikel ${a.sku} ist deaktiviert`);
    const place = m.place_id ?? a.default_place_id ?? defaultPlace(app, locationId);
    if (!app.db.get('SELECT 1 FROM inv_places WHERE id = ? AND location_id = ?', place, locationId)) throw notFound('Lagerort nicht gefunden');
    const before = placeQty(app, a.id, place);
    const after = q3(before + signed);
    if (after < 0 && !m.allowNegative) throw bad(`Bestand nicht ausreichend: ${a.sku} hat im Lagerort ${q3(before)} ${a.unit}, gebucht werden sollen ${q3(-signed)}`);
    const totalBefore = totalQty(app, locationId, a.id);
    let avg = a.avg_cost_cents;
    let unitCost = a.avg_cost_cents;
    let last = a.last_cost_cents;
    if (m.type === 'receipt' && m.unit_cost_cents !== undefined && m.unit_cost_cents !== null) {
      const cost = Math.round(Number(m.unit_cost_cents));
      if (!Number.isFinite(cost) || cost < 0) throw bad('Einkaufspreis ungültig');
      unitCost = cost;
      last = cost;
      // Moving average over the stock on hand (nothing, if the stock was empty or negative).
      const base = Math.max(totalBefore, 0);
      avg = base + signed > 0 ? Math.round((base * a.avg_cost_cents + signed * cost) / (base + signed)) : cost;
    } else if (m.type === 'receipt' && !a.avg_cost_cents) {
      unitCost = 0;
    }
    const total = q3(totalBefore + signed);
    const mid = id();
    app.db.run(
      `INSERT INTO inv_stock (location_id, article_id, place_id, qty) VALUES (?, ?, ?, ?) ON CONFLICT(article_id, place_id) DO UPDATE SET qty = excluded.qty`,
      locationId, a.id, place, after,
    );
    app.db.run(
      `INSERT INTO inv_movements (id, location_id, article_id, place_id, type, qty, unit_cost_cents, value_cents, avg_after_cents, ref_type, ref_id, transfer_id, note, balance, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mid, locationId, a.id, place, m.type, signed, unitCost, Math.round(signed * unitCost), avg, m.ref_type ?? '', m.ref_id ?? '', m.transfer_id ?? '', String(m.note ?? '').slice(0, 300), total, m.user_id ?? null, now(),
    );
    // Alert once per drop below the minimum; armed again when the stock is above it.
    const min = Number(a.min_stock) || 0;
    const isLow = min > 0 && total <= min;
    let low = false;
    if (isLow && !a.low_notified && signed < 0) {
      low = true;
    }
    app.db.run('UPDATE inv_articles SET avg_cost_cents = ?, last_cost_cents = ?, low_notified = ?, updated_at = ? WHERE id = ?', avg, last, isLow ? (low || a.low_notified ? 1 : 0) : 0, now(), a.id);
    const article = { ...a, avg_cost_cents: avg, last_cost_cents: last };
    if (low) announceLow(app, locationId, article, total);
    return { id: mid, balance: total, low, article };
  });
}

/** `stock.low` for workflows and webhooks (contact = the article's supplier, so a workflow can write to them) + a notification. */
function announceLow(app: App, locationId: string, a: ArticleRow, qty: number) {
  const data = { contactId: a.supplier_contact_id ?? undefined, articleId: a.id, sku: a.sku, name: a.name, qty, min_stock: a.min_stock, reorder_qty: a.reorder_qty, unit: a.unit, supplier: a.supplier_name };
  // Emitted after the transaction (listeners run later anyway).
  app.events.emit(locationId, 'stock.low', data);
  try {
    const users = usersWithArea(app, locationId, 'inventory');
    if (users.length) {
      void Promise.resolve(app.services.pushNotify?.({ userIds: users, kind: 'stock', title: `Mindestbestand unterschritten: ${a.name}`, body: `${a.sku}: ${qty} ${a.unit} (Minimum ${a.min_stock})`, url: '/app/inventory', tag: `stock-${a.id}` })).catch(() => undefined);
    }
  } catch (e) {
    console.error('[inventory] notify', (e as Error).message);
  }
}

/** Moves stock between two places: two linked log entries. */
export function transferStock(app: App, locationId: string, t: { article_id: string; from_place_id: string; to_place_id: string; qty: number; note?: string; user_id?: string | null }) {
  if (t.from_place_id === t.to_place_id) throw bad('Quell- und Ziel-Lagerort müssen verschieden sein');
  const tid = id();
  return txn(app, () => {
    const out = applyMovement(app, locationId, { article_id: t.article_id, place_id: t.from_place_id, type: 'transfer_out', qty: t.qty, transfer_id: tid, note: t.note, user_id: t.user_id });
    const inn = applyMovement(app, locationId, { article_id: t.article_id, place_id: t.to_place_id, type: 'transfer_in', qty: t.qty, transfer_id: tid, note: t.note, user_id: t.user_id });
    return { transfer_id: tid, out, in: inn };
  });
}

// --- valuation ----------------------------------------------------------------------------------------------------

export interface ValuationRow {
  article_id: string;
  sku: string;
  name: string;
  unit: string;
  qty: number;
  avg_cost_cents: number;
  value_cents: number;
  places: { place_id: string; place: string; qty: number; value_cents: number }[];
}

/**
 * Stock valuation at moving-average cost. With `asof` the quantities come from the movement log up to that day and
 * the cost is the average after the last movement of the article until then.
 */
export function valuation(app: App, locationId: string, asof?: string) {
  const places = new Map(app.db.all<{ id: string; name: string }>('SELECT id, name FROM inv_places WHERE location_id = ?', locationId).map((p) => [p.id, p.name]));
  const arts = app.db.all<ArticleRow>('SELECT * FROM inv_articles WHERE location_id = ? ORDER BY sku', locationId);
  let perPlace: { article_id: string; place_id: string; qty: number }[];
  let avg = new Map<string, number>();
  if (asof) {
    // The key date ends at midnight in the sub-account's zone: "T23:59:59Z" took in the first one or two hours of the next day (Berlin).
    const end = zonedToUtc(addDaysYmd(asof, 1), '00:00', app.location(locationId)?.timezone || 'Europe/Berlin').toISOString();
    perPlace = app.db.all<any>('SELECT article_id, place_id, ROUND(SUM(qty), 3) AS qty FROM inv_movements WHERE location_id = ? AND created_at < ? GROUP BY article_id, place_id', locationId, end);
    for (const r of app.db.all<{ article_id: string; avg: number }>(
      `SELECT m.article_id, m.avg_after_cents AS avg FROM inv_movements m
       WHERE m.location_id = ? AND m.created_at < ? AND m.rowid = (SELECT MAX(x.rowid) FROM inv_movements x WHERE x.article_id = m.article_id AND x.created_at < ?)`,
      locationId, end, end,
    )) avg.set(r.article_id, r.avg);
  } else {
    perPlace = app.db.all<any>('SELECT article_id, place_id, qty FROM inv_stock WHERE location_id = ?', locationId);
    avg = new Map(arts.map((a) => [a.id, a.avg_cost_cents]));
  }
  const byArt = new Map<string, typeof perPlace>();
  for (const r of perPlace) if (r.qty) byArt.set(r.article_id, [...(byArt.get(r.article_id) ?? []), r]);
  const rows: ValuationRow[] = [];
  for (const a of arts) {
    const list = byArt.get(a.id);
    if (!list) continue;
    const cost = avg.get(a.id) ?? a.avg_cost_cents;
    const plc = list.map((p) => ({ place_id: p.place_id, place: places.get(p.place_id) ?? '?', qty: q3(p.qty), value_cents: Math.round(Math.max(p.qty, 0) * cost) }));
    const qty = q3(list.reduce((n, p) => n + p.qty, 0));
    rows.push({ article_id: a.id, sku: a.sku, name: a.name, unit: a.unit, qty, avg_cost_cents: cost, value_cents: plc.reduce((n, p) => n + p.value_cents, 0), places: plc });
  }
  return { asof: asof ?? null, method: 'Gleitender Durchschnittspreis', rows, total_cents: rows.reduce((n, r) => n + r.value_cents, 0), articles: rows.length };
}

// --- low stock ------------------------------------------------------------------------------------------------------

export function lowStock(app: App, locationId: string) {
  return app.db
    .all<ArticleRow & { qty: number }>(
      `SELECT a.*, COALESCE((SELECT SUM(s.qty) FROM inv_stock s WHERE s.article_id = a.id), 0) AS qty FROM inv_articles a
       WHERE a.location_id = ? AND a.active = 1 AND a.track = 1 AND a.min_stock > 0 ORDER BY a.sku`,
      locationId,
    )
    .filter((a) => q3(a.qty) <= a.min_stock)
    .map((a) => ({ id: a.id, sku: a.sku, name: a.name, unit: a.unit, qty: q3(a.qty), min_stock: a.min_stock, reorder_qty: a.reorder_qty, missing: q3(Math.max(0, a.min_stock - a.qty)), supplier: a.supplier_name, supplier_contact_id: a.supplier_contact_id }));
}

// --- automatic goods issue for invoices --------------------------------------------------------------------------------

interface LineItem {
  name: string;
  description?: string;
  qty: number;
}
type Candidate = Pick<ArticleRow, 'id' | 'sku' | 'name' | 'ean'> & { product_name?: string | null };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Which article an invoice line refers to: an SKU in the text ("[AB-100]", "SKU: AB-100", or the whole name), the name of
 * the product the article is linked to, or the article's own name. Null when nothing fits clearly.
 */
export function matchItem(item: LineItem, articles: Candidate[]): Candidate | null {
  const text = `${item.name} ${item.description ?? ''}`;
  const bySku = (sku: string) => articles.find((a) => a.sku && a.sku.toLowerCase() === sku.toLowerCase());
  const bracket = /\[([^\]\s]{2,40})\]|SKU\s*[:#]?\s*([A-Za-z0-9._\-/]{2,40})/gi;
  for (const m of text.matchAll(bracket)) {
    const hit = bySku(m[1] ?? m[2]);
    if (hit) return hit;
  }
  const whole = bySku(item.name.trim());
  if (whole) return whole;
  const n = norm(item.name);
  const byProduct = articles.filter((a) => a.product_name && norm(a.product_name) === n);
  if (byProduct.length === 1) return byProduct[0];
  const byName = articles.filter((a) => norm(a.name) === n);
  if (byName.length === 1) return byName[0];
  return null;
}

/**
 * Takes the articles of an invoice out of stock (once per invoice and article). Unmatched lines are returned, nothing
 * fails. Automatic issues may take the stock below zero – the low-stock alert tells.
 */
export function issueForInvoice(app: App, locationId: string, inv: { id: string; number: string; items: LineItem[] | string }) {
  const items: LineItem[] = typeof inv.items === 'string' ? JSON.parse(inv.items) : inv.items;
  const arts = app.db.all<Candidate & { auto_issue: number; track: number; default_place_id: string | null }>(
    `SELECT a.id, a.sku, a.name, a.ean, a.auto_issue, a.track, a.default_place_id, p.name AS product_name FROM inv_articles a LEFT JOIN products p ON p.id = a.product_id AND p.location_id = a.location_id
     WHERE a.location_id = ? AND a.active = 1 AND a.track = 1 AND a.auto_issue = 1`,
    locationId,
  );
  const sums = new Map<string, number>();
  const unmatched: string[] = [];
  for (const it of items) {
    const a = matchItem(it, arts);
    const qty = Number(it.qty);
    if (!a || !(qty > 0)) {
      if (!a) unmatched.push(it.name);
      continue;
    }
    sums.set(a.id, q3((sums.get(a.id) ?? 0) + qty));
  }
  const issued: { article_id: string; sku: string; qty: number }[] = [];
  for (const [articleId, qty] of sums) {
    if (app.db.get('SELECT 1 FROM inv_movements WHERE location_id = ? AND ref_type = ? AND ref_id = ? AND article_id = ?', locationId, 'invoice', inv.id, articleId)) continue;
    const a = arts.find((x) => x.id === articleId)!;
    applyMovement(app, locationId, { article_id: articleId, place_id: a.default_place_id, type: 'issue', qty, ref_type: 'invoice', ref_id: inv.id, note: `Rechnung ${inv.number}`, allowNegative: true });
    issued.push({ article_id: articleId, sku: a.sku, qty });
  }
  return { issued, unmatched };
}

// --- inventory count ----------------------------------------------------------------------------------------------------

export function startCount(app: App, locationId: string, o: { name: string; place_id?: string | null; user_id?: string | null; note?: string }) {
  if (o.place_id && !app.db.get('SELECT 1 FROM inv_places WHERE id = ? AND location_id = ?', o.place_id, locationId)) throw notFound('Lagerort nicht gefunden');
  // One open count per area: a count of everything excludes the others, a place excludes the same place and the whole.
  const open = app.db.all<{ place_id: string | null }>(`SELECT place_id FROM inv_counts WHERE location_id = ? AND status = 'open'`, locationId);
  if (open.some((c) => !c.place_id || !o.place_id || c.place_id === o.place_id)) throw bad('Es läuft schon eine Inventur für diesen Bereich – bitte zuerst abschließen oder abbrechen');
  const cid = id();
  txn(app, () => {
    app.db.run(`INSERT INTO inv_counts (id, location_id, name, place_id, status, note, created_by, created_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`, cid, locationId, o.name.slice(0, 120), o.place_id ?? null, String(o.note ?? '').slice(0, 300), o.user_id ?? null, now());
    const add = (articleId: string, placeId: string, qty: number) => app.db.run('INSERT INTO inv_count_lines (id, count_id, location_id, article_id, place_id, expected, counted) VALUES (?, ?, ?, ?, ?, ?, NULL)', id(), cid, locationId, articleId, placeId, q3(qty));
    if (o.place_id) {
      // Every tracked article at this place, with the quantity the books expect there (possibly 0: it may be found).
      for (const a of app.db.all<{ id: string }>('SELECT id FROM inv_articles WHERE location_id = ? AND active = 1 AND track = 1 ORDER BY sku', locationId)) add(a.id, o.place_id, placeQty(app, a.id, o.place_id));
    } else {
      for (const r of app.db.all<{ article_id: string; place_id: string; qty: number }>(`SELECT s.article_id, s.place_id, s.qty FROM inv_stock s JOIN inv_articles a ON a.id = s.article_id WHERE s.location_id = ? AND a.active = 1 AND a.track = 1 AND s.qty != 0`, locationId)) add(r.article_id, r.place_id, r.qty);
    }
  });
  return cid;
}

export function countReport(app: App, locationId: string, countId: string) {
  const c = app.db.get<any>('SELECT * FROM inv_counts WHERE id = ? AND location_id = ?', countId, locationId);
  if (!c) throw notFound('Inventur nicht gefunden');
  const lines = app.db.all<any>(
    `SELECT l.id, l.article_id, l.place_id, l.expected, l.counted, a.sku, a.name, a.unit, a.avg_cost_cents, p.name AS place
     FROM inv_count_lines l JOIN inv_articles a ON a.id = l.article_id LEFT JOIN inv_places p ON p.id = l.place_id WHERE l.count_id = ? AND l.location_id = ? ORDER BY a.sku, p.name`,
    countId, locationId,
  ).map((l) => {
    const diff = l.counted === null ? null : q3(l.counted - l.expected);
    return { ...l, diff, diff_value_cents: diff === null ? null : Math.round(diff * l.avg_cost_cents) };
  });
  const counted = lines.filter((l) => l.counted !== null);
  return {
    ...c,
    lines,
    summary: {
      lines: lines.length,
      counted: counted.length,
      differences: counted.filter((l) => l.diff !== 0).length,
      surplus_value_cents: counted.reduce((n, l) => n + Math.max(0, l.diff_value_cents), 0),
      shortage_value_cents: counted.reduce((n, l) => n + Math.min(0, l.diff_value_cents), 0),
    },
  };
}

/** Closes the count: every counted line with a difference becomes a count movement; uncounted lines stay untouched. */
export function closeCount(app: App, locationId: string, countId: string, user: string | null) {
  const c = app.db.get<any>('SELECT * FROM inv_counts WHERE id = ? AND location_id = ?', countId, locationId);
  if (!c) throw notFound('Inventur nicht gefunden');
  if (c.status !== 'open') throw bad('Diese Inventur ist schon abgeschlossen');
  return txn(app, () => {
    const lines = app.db.all<{ article_id: string; place_id: string; expected: number; counted: number }>('SELECT article_id, place_id, expected, counted FROM inv_count_lines WHERE count_id = ? AND counted IS NOT NULL', countId);
    let booked = 0;
    for (const l of lines) {
      // The difference to what is in stock now (movements since the count started are respected, not overwritten).
      const now0 = placeQty(app, l.article_id, l.place_id);
      const diff = q3(l.counted - now0);
      if (diff === 0) continue;
      applyMovement(app, locationId, { article_id: l.article_id, place_id: l.place_id, type: 'count', qty: diff, ref_type: 'count', ref_id: countId, note: `Inventur ${c.name}`, user_id: user, allowNegative: true });
      booked++;
    }
    app.db.run(`UPDATE inv_counts SET status = 'closed', closed_at = ? WHERE id = ?`, now(), countId);
    return { booked, report: countReport(app, locationId, countId) };
  });
}

export const insufficient = (e: unknown) => e instanceof HttpError && /nicht ausreichend/.test(e.message);
