import type { App, Module } from '../core/app.js';
import { bad, clampLimit, notFound, num, str, type Ctx } from '../core/http.js';
import { addDaysYmd, zonedToUtc } from '../core/time.js';
import { id, now } from '../core/util.js';
import { centsToMoney } from '../core/util.js';
import { q3, semicolonCsv, moneyDe, today } from '../services/bo-common.js';
import { sendToContact } from '../services/messaging.js';
import {
  MOVEMENT_LABELS,
  applyMovement,
  closeCount,
  countReport,
  defaultPlace,
  getArticle,
  getInvSettings,
  issueForInvoice,
  lowStock,
  startCount,
  totalQty,
  transferStock,
  valuation,
  type ArticleRow,
  type MovementType,
} from '../services/inv-stock.js';
import type { Tool } from './mcp.js';

/**
 * Lager & Einkauf: articles (linked to products, with variants, SKU and EAN), storage places, stock movements, minimum
 * stock alerts, inventory counts with differences, simple purchase orders to suppliers (CRM contacts) with goods receipt,
 * stock valuation, and the automatic goods issue when an invoice is paid or sent (configurable).
 */

/** EAN-8/UPC-A/EAN-13/GTIN-14 check digit. */
export function validEan(v: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(v)) return false;
  const d = v.split('').map(Number);
  const check = d.pop()!;
  const sum = d.reverse().reduce((n, x, i) => n + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_stock_levels',
    title: 'Lagerbestand',
    description: 'Bestände der Artikel im Lager (Menge gesamt und je Lagerort, Mindestbestand, Einheit, Warnung bei Unterschreitung). query sucht in Artikelnummer, Name und EAN; low_only=true nur Artikel am oder unter dem Mindestbestand.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, query: { type: 'string' }, low_only: { type: 'boolean' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/inventory/stock?${new URLSearchParams({ ...(a.query ? { q: a.query } : {}), ...(a.low_only ? { low: '1' } : {}) })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_low_stock',
    title: 'Mindestbestand unterschritten',
    description: 'Artikel, deren Bestand den Mindestbestand erreicht oder unterschreitet – mit Fehlmenge, Nachbestellmenge und Lieferant.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', '/api/inventory/low-stock', { location: a.location_id }),
  },
  {
    name: 'ghl_stock_movement',
    title: 'Lagerbewegung buchen',
    description: 'Bucht einen Wareneingang (receipt, optional unit_cost_cents), Warenausgang (issue) oder eine Korrektur (correction, auch negativ) für einen Artikel (article_id oder sku). Ändert den Bestand.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        article_id: { type: 'string' },
        sku: { type: 'string' },
        type: { type: 'string', enum: ['receipt', 'issue', 'correction'] },
        qty: { type: 'number' },
        unit_cost_cents: { type: 'integer' },
        note: { type: 'string' },
      },
      required: ['type', 'qty'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      let articleId = a.article_id;
      if (!articleId && a.sku) {
        const list: any[] = await call.api('GET', `/api/inventory/stock?q=${encodeURIComponent(a.sku)}`, { location: a.location_id });
        articleId = list.find((x) => String(x.sku).toLowerCase() === String(a.sku).toLowerCase())?.id;
      }
      if (!articleId) throw new Error('Artikel nicht gefunden (article_id oder sku angeben)');
      return call.api('POST', '/api/inventory/movements', { location: a.location_id, body: { article_id: articleId, type: a.type, qty: a.qty, unit_cost_cents: a.unit_cost_cents, note: a.note } });
    },
  },
];

export const INVENTORY_TRIGGERS = ['stock.low', 'purchase_order.received'];

const MIGRATION = `
CREATE TABLE inv_settings (location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE inv_places (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(location_id, name)
);
CREATE TABLE inv_articles (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, sku TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  ean TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'Stk', product_id TEXT, parent_id TEXT, variant TEXT NOT NULL DEFAULT '',
  min_stock REAL NOT NULL DEFAULT 0, reorder_qty REAL NOT NULL DEFAULT 0, avg_cost_cents INTEGER NOT NULL DEFAULT 0, last_cost_cents INTEGER NOT NULL DEFAULT 0,
  supplier_contact_id TEXT, supplier_name TEXT NOT NULL DEFAULT '', supplier_sku TEXT NOT NULL DEFAULT '',
  track INTEGER NOT NULL DEFAULT 1, auto_issue INTEGER NOT NULL DEFAULT 1, default_place_id TEXT, low_notified INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, sku)
);
CREATE INDEX inv_articles_product ON inv_articles(location_id, product_id);
CREATE INDEX inv_articles_parent ON inv_articles(parent_id);
CREATE INDEX inv_articles_contact ON inv_articles(supplier_contact_id);
CREATE INDEX inv_articles_ean ON inv_articles(location_id, ean);
CREATE TABLE inv_stock (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, article_id TEXT NOT NULL REFERENCES inv_articles(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES inv_places(id) ON DELETE CASCADE, qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (article_id, place_id)
);
CREATE INDEX inv_stock_loc ON inv_stock(location_id);
CREATE TABLE inv_movements (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, article_id TEXT NOT NULL REFERENCES inv_articles(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL, type TEXT NOT NULL, qty REAL NOT NULL, unit_cost_cents INTEGER NOT NULL DEFAULT 0, value_cents INTEGER NOT NULL DEFAULT 0,
  avg_after_cents INTEGER NOT NULL DEFAULT 0, ref_type TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '', transfer_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', balance REAL NOT NULL DEFAULT 0, user_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX inv_movements_article ON inv_movements(location_id, article_id, created_at);
CREATE INDEX inv_movements_date ON inv_movements(location_id, created_at);
CREATE INDEX inv_movements_ref ON inv_movements(location_id, ref_type, ref_id);
CREATE TABLE inv_counts (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL, place_id TEXT, status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX inv_counts_loc ON inv_counts(location_id, status);
CREATE TABLE inv_count_lines (
  id TEXT PRIMARY KEY, count_id TEXT NOT NULL REFERENCES inv_counts(id) ON DELETE CASCADE, location_id TEXT NOT NULL, article_id TEXT NOT NULL REFERENCES inv_articles(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL, expected REAL NOT NULL DEFAULT 0, counted REAL, UNIQUE(count_id, article_id, place_id)
);
CREATE TABLE inv_orders (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, number TEXT NOT NULL, contact_id TEXT, supplier_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft', expected_at TEXT, notes TEXT NOT NULL DEFAULT '', ordered_at TEXT, received_at TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, number)
);
CREATE INDEX inv_orders_loc ON inv_orders(location_id, status);
CREATE INDEX inv_orders_contact ON inv_orders(contact_id);
CREATE TABLE inv_order_lines (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES inv_orders(id) ON DELETE CASCADE, location_id TEXT NOT NULL, article_id TEXT NOT NULL REFERENCES inv_articles(id) ON DELETE CASCADE,
  qty REAL NOT NULL, received REAL NOT NULL DEFAULT 0, unit_cost_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX inv_order_lines_order ON inv_order_lines(order_id);
`;

interface PlaceRow {
  id: string;
  name: string;
  code: string;
  is_default: number;
  active: number;
}

export const inventoryModule: Module = {
  name: 'inventory',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...INVENTORY_TRIGGERS];
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        db.run('UPDATE inv_articles SET supplier_contact_id = NULL WHERE location_id = ? AND supplier_contact_id = ?', loc, contact.id);
        db.run('UPDATE inv_orders SET contact_id = NULL WHERE location_id = ? AND contact_id = ?', loc, contact.id);
      },
    ];
    // Access (Art. 15): the articles the person supplies (orders have a contact_id and are in the generic export).
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        const rows = db.all('SELECT sku, name, supplier_name, supplier_sku, last_cost_cents, created_at FROM inv_articles WHERE location_id = ? AND supplier_contact_id = ?', loc, contact.id);
        return rows.length ? { 'inv_articles (Lieferant)': rows } : {};
      },
    ];

    const userId = (ctx: Ctx) => (ctx.user && ctx.via !== 'agency_key' && ctx.via !== 'mcp' ? ctx.user.id : null);
    const contactOf = (loc: string, cid: unknown): string | null => {
      if (!cid) return null;
      if (!db.get('SELECT 1 FROM contacts WHERE id = ? AND location_id = ?', String(cid), loc)) throw bad('Kontakt nicht gefunden');
      return String(cid);
    };

    // --- status & settings ---------------------------------------------------------------------------------------
    router.get('/api/inventory/status', 'location', (ctx) => {
      const loc = ctx.locationId;
      const one = (sql: string, ...p: any[]) => db.get<{ n: number }>(sql, ...p)?.n ?? 0;
      return {
        settings: getInvSettings(app, loc),
        articles: one('SELECT COUNT(*) AS n FROM inv_articles WHERE location_id = ? AND active = 1', loc),
        places: one('SELECT COUNT(*) AS n FROM inv_places WHERE location_id = ? AND active = 1', loc),
        low: lowStock(app, loc).length,
        value_cents: valuation(app, loc).total_cents,
        open_orders: one(`SELECT COUNT(*) AS n FROM inv_orders WHERE location_id = ? AND status IN ('draft', 'ordered', 'partial')`, loc),
        open_counts: one(`SELECT COUNT(*) AS n FROM inv_counts WHERE location_id = ? AND status = 'open'`, loc),
      };
    });
    router.get('/api/inventory/settings', 'location', (ctx) => getInvSettings(app, ctx.locationId));
    router.put('/api/inventory/settings', 'location', (ctx) => {
      const cur = getInvSettings(app, ctx.locationId);
      const b = ctx.body ?? {};
      if (b.auto_issue_on !== undefined && !['paid', 'sent', 'off'].includes(b.auto_issue_on)) throw bad('Automatischer Warenausgang: paid, sent oder off');
      const next = { auto_issue_on: b.auto_issue_on ?? cur.auto_issue_on, allow_negative: b.allow_negative === undefined ? cur.allow_negative : !!b.allow_negative };
      db.run(`INSERT INTO inv_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, ctx.locationId, JSON.stringify(next), now());
      return next;
    });

    // --- places ---------------------------------------------------------------------------------------------------------
    router.get('/api/inventory/places', 'location', (ctx) => {
      defaultPlace(app, ctx.locationId);
      return db.all(
        `SELECT p.*, (SELECT COUNT(DISTINCT s.article_id) FROM inv_stock s WHERE s.place_id = p.id AND s.qty != 0) AS articles FROM inv_places p WHERE p.location_id = ? ORDER BY p.is_default DESC, p.name`,
        ctx.locationId,
      );
    });
    router.post('/api/inventory/places', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { required: true, max: 80 });
      if (db.get('SELECT 1 FROM inv_places WHERE location_id = ? AND name = ?', ctx.locationId, name)) throw bad('Diesen Lagerort gibt es schon');
      const first = !db.get('SELECT 1 FROM inv_places WHERE location_id = ?', ctx.locationId);
      const row = { id: id(), location_id: ctx.locationId, name, code: str(ctx.body?.code, 'Kürzel', { max: 20 }), is_default: first ? 1 : 0, active: 1, created_at: now() };
      db.insert('inv_places', row);
      return row;
    });
    router.patch('/api/inventory/places/:id', 'location', (ctx) => {
      const p = db.get<PlaceRow>('SELECT * FROM inv_places WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Lagerort nicht gefunden');
      const patch: Record<string, any> = {};
      if (ctx.body?.name !== undefined) {
        patch.name = str(ctx.body.name, 'Name', { required: true, max: 80 });
        if (db.get('SELECT 1 FROM inv_places WHERE location_id = ? AND name = ? AND id != ?', ctx.locationId, patch.name, p.id)) throw bad('Diesen Lagerort gibt es schon');
      }
      if (ctx.body?.code !== undefined) patch.code = str(ctx.body.code, 'Kürzel', { max: 20 });
      if (ctx.body?.active !== undefined) {
        if (!ctx.body.active && db.get('SELECT 1 FROM inv_stock WHERE place_id = ? AND qty != 0', p.id)) throw bad('Im Lagerort liegt noch Ware – bitte erst umlagern');
        patch.active = ctx.body.active ? 1 : 0;
      }
      db.tx(() => {
        if (ctx.body?.is_default === true) {
          db.run('UPDATE inv_places SET is_default = 0 WHERE location_id = ?', ctx.locationId);
          patch.is_default = 1;
          patch.active = 1;
        }
        db.update('inv_places', p.id, patch, ctx.locationId);
      });
      return db.get('SELECT * FROM inv_places WHERE id = ?', p.id);
    });
    router.delete('/api/inventory/places/:id', 'location', (ctx) => {
      const p = db.get<PlaceRow>('SELECT * FROM inv_places WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!p) throw notFound('Lagerort nicht gefunden');
      if (db.get('SELECT 1 FROM inv_movements WHERE place_id = ? LIMIT 1', p.id)) throw bad('Der Lagerort hat Bewegungen – bitte deaktivieren statt löschen');
      db.run('DELETE FROM inv_places WHERE id = ?', p.id);
      return { ok: true };
    });

    // --- articles ----------------------------------------------------------------------------------------------------------
    const articleOut = (a: ArticleRow & { qty?: number }, places?: { place_id: string; place: string; qty: number }[]) => {
      const qty = q3(a.qty ?? totalQty(app, a.location_id, a.id));
      const { low_notified: _l, ...rest } = a;
      return { ...rest, qty, value_cents: Math.round(Math.max(qty, 0) * a.avg_cost_cents), low: a.track === 1 && a.min_stock > 0 && qty <= a.min_stock, ...(places ? { places } : {}) };
    };
    const placesOf = (articleIds: string[], loc: string) => {
      const out = new Map<string, { place_id: string; place: string; qty: number }[]>();
      if (!articleIds.length) return out;
      for (const r of db.all<any>(`SELECT s.article_id, s.place_id, p.name AS place, s.qty FROM inv_stock s JOIN inv_places p ON p.id = s.place_id WHERE s.location_id = ? AND s.qty != 0 AND s.article_id IN (${articleIds.map(() => '?').join(',')}) ORDER BY p.name`, loc, ...articleIds)) out.set(r.article_id, [...(out.get(r.article_id) ?? []), { place_id: r.place_id, place: r.place, qty: q3(r.qty) }]);
      return out;
    };
    const listArticles = (ctx: Ctx) => {
      const where = ['a.location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (ctx.query.get('all') !== '1') where.push('a.active = 1');
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push('(a.sku LIKE ? OR a.name LIKE ? OR a.ean LIKE ? OR a.variant LIKE ? OR a.supplier_name LIKE ?)'), params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`));
      const place = ctx.query.get('place');
      if (place) (where.push('EXISTS (SELECT 1 FROM inv_stock s WHERE s.article_id = a.id AND s.place_id = ? AND s.qty != 0)'), params.push(place));
      const rows = db.all<ArticleRow & { qty: number }>(
        `SELECT a.*, COALESCE((SELECT SUM(s.qty) FROM inv_stock s WHERE s.article_id = a.id), 0) AS qty FROM inv_articles a WHERE ${where.join(' AND ')} ORDER BY a.sku LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 500, 2000),
      );
      const places = placesOf(rows.map((r) => r.id), ctx.locationId);
      let out = rows.map((r) => articleOut(r, places.get(r.id) ?? []));
      if (ctx.query.get('low') === '1') out = out.filter((a) => a.low);
      return out;
    };
    router.get('/api/inventory/articles', 'location', (ctx) => listArticles(ctx));
    // Flat levels for people and tools (MCP).
    router.get('/api/inventory/stock', 'location', (ctx) => listArticles(ctx).map((a) => ({ id: a.id, sku: a.sku, name: a.name, variant: a.variant, ean: a.ean, unit: a.unit, qty: a.qty, min_stock: a.min_stock, low: a.low, value_cents: a.value_cents, places: a.places })));
    router.get('/api/inventory/low-stock', 'location', (ctx) => lowStock(app, ctx.locationId));

    const cleanArticle = (loc: string, b: any, cur?: ArticleRow) => {
      const out: Record<string, any> = {};
      if (b.sku !== undefined || !cur) {
        const sku = str(b.sku, 'Artikelnummer', { required: !cur, max: 40 });
        if (sku) {
          if (!/^[\w.\-/ ]+$/.test(sku)) throw bad('Artikelnummer: Buchstaben, Ziffern und . - _ / erlaubt');
          if (db.get('SELECT 1 FROM inv_articles WHERE location_id = ? AND lower(sku) = lower(?) AND id != ?', loc, sku, cur?.id ?? '')) throw bad(`Artikelnummer ${sku} gibt es schon`);
          out.sku = sku;
        }
      }
      if (b.name !== undefined || !cur) out.name = str(b.name, 'Name', { required: true, max: 200 });
      for (const [k, max] of [['description', 2000], ['variant', 80], ['supplier_name', 200], ['supplier_sku', 60]] as const) if (b[k] !== undefined) out[k] = str(b[k], k, { max });
      if (b.unit !== undefined) out.unit = str(b.unit, 'Einheit', { max: 12 }) || 'Stk';
      if (b.ean !== undefined) {
        const ean = str(b.ean, 'EAN', { max: 14 }).replace(/\s+/g, '');
        if (ean && !validEan(ean)) throw bad('Die EAN ist nicht gültig (8, 12, 13 oder 14 Ziffern mit korrekter Prüfziffer)');
        out.ean = ean;
      }
      for (const k of ['min_stock', 'reorder_qty'] as const)
        if (b[k] !== undefined) {
          const n = num(b[k], NaN);
          if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad(k === 'min_stock' ? 'Mindestbestand ungültig' : 'Nachbestellmenge ungültig');
          out[k] = q3(n);
        }
      for (const k of ['track', 'auto_issue', 'active'] as const) if (b[k] !== undefined) out[k] = b[k] ? 1 : 0;
      if (b.product_id !== undefined) {
        if (b.product_id && !db.get('SELECT 1 FROM products WHERE id = ? AND location_id = ?', String(b.product_id), loc)) throw bad('Produkt nicht gefunden');
        out.product_id = b.product_id ? String(b.product_id) : null;
      }
      if (b.parent_id !== undefined) {
        if (b.parent_id) {
          if (cur && b.parent_id === cur.id) throw bad('Ein Artikel kann nicht seine eigene Variante sein');
          if (!db.get('SELECT 1 FROM inv_articles WHERE id = ? AND location_id = ?', String(b.parent_id), loc)) throw bad('Hauptartikel nicht gefunden');
        }
        out.parent_id = b.parent_id ? String(b.parent_id) : null;
      }
      if (b.supplier_contact_id !== undefined) out.supplier_contact_id = contactOf(loc, b.supplier_contact_id);
      if (b.default_place_id !== undefined) {
        if (b.default_place_id && !db.get('SELECT 1 FROM inv_places WHERE id = ? AND location_id = ?', String(b.default_place_id), loc)) throw bad('Lagerort nicht gefunden');
        out.default_place_id = b.default_place_id ? String(b.default_place_id) : null;
      }
      return out;
    };
    const nextSku = (loc: string) => {
      for (let n = (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inv_articles WHERE location_id = ?', loc)?.n ?? 0) + 1; ; n++) {
        const sku = `A-${String(n).padStart(4, '0')}`;
        if (!db.get('SELECT 1 FROM inv_articles WHERE location_id = ? AND sku = ?', loc, sku)) return sku;
      }
    };

    router.post('/api/inventory/articles', 'location', (ctx) => {
      const b = { ...(ctx.body ?? {}) };
      if (!str(b.sku, 'Artikelnummer')) b.sku = nextSku(ctx.locationId);
      const f = cleanArticle(ctx.locationId, b);
      const row = { id: id(), location_id: ctx.locationId, description: '', ean: '', unit: 'Stk', variant: '', min_stock: 0, reorder_qty: 0, avg_cost_cents: 0, last_cost_cents: 0, supplier_name: '', supplier_sku: '', track: 1, auto_issue: 1, active: 1, low_notified: 0, created_at: now(), updated_at: now(), ...f };
      const initial = q3(num(b.initial_qty, 0));
      db.tx(() => {
        db.insert('inv_articles', row);
        if (initial > 0) applyMovement(app, ctx.locationId, { article_id: row.id, type: 'receipt', qty: initial, unit_cost_cents: b.initial_cost_cents !== undefined ? Math.round(num(b.initial_cost_cents, 0)) : undefined, ref_type: 'manual', note: 'Anfangsbestand', user_id: userId(ctx) });
      });
      return articleOut(getArticle(app, ctx.locationId, row.id));
    });
    router.post('/api/inventory/articles/from-product', 'location', (ctx) => {
      const p = db.get<{ id: string; name: string; description: string }>('SELECT id, name, description FROM products WHERE id = ? AND location_id = ?', String(ctx.body?.product_id ?? ''), ctx.locationId);
      if (!p) throw notFound('Produkt nicht gefunden');
      const existing = db.get<{ id: string }>('SELECT id FROM inv_articles WHERE location_id = ? AND product_id = ?', ctx.locationId, p.id);
      if (existing) return articleOut(getArticle(app, ctx.locationId, existing.id));
      const f = cleanArticle(ctx.locationId, { sku: str(ctx.body?.sku, 'Artikelnummer') || nextSku(ctx.locationId), name: p.name, description: p.description, product_id: p.id });
      const row = { id: id(), location_id: ctx.locationId, description: '', ean: '', unit: 'Stk', variant: '', min_stock: 0, reorder_qty: 0, avg_cost_cents: 0, last_cost_cents: 0, supplier_name: '', supplier_sku: '', track: 1, auto_issue: 1, active: 1, low_notified: 0, created_at: now(), updated_at: now(), ...f };
      db.insert('inv_articles', row);
      return articleOut(getArticle(app, ctx.locationId, row.id));
    });
    router.get('/api/inventory/articles/:id', 'location', (ctx) => {
      const a = getArticle(app, ctx.locationId, ctx.params.id);
      const places = placesOf([a.id], ctx.locationId).get(a.id) ?? [];
      const movements = db.all(`SELECT m.*, p.name AS place FROM inv_movements m LEFT JOIN inv_places p ON p.id = m.place_id WHERE m.location_id = ? AND m.article_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT 50`, ctx.locationId, a.id);
      const variants = db.all('SELECT id, sku, name, variant FROM inv_articles WHERE location_id = ? AND parent_id = ? ORDER BY sku', ctx.locationId, a.id);
      return { ...articleOut(a, places), movements, variants };
    });
    router.patch('/api/inventory/articles/:id', 'location', (ctx) => {
      const a = getArticle(app, ctx.locationId, ctx.params.id);
      const f = cleanArticle(ctx.locationId, ctx.body ?? {}, a);
      if (f.min_stock !== undefined) f.low_notified = 0;
      db.update('inv_articles', a.id, { ...f, updated_at: now() }, ctx.locationId);
      return articleOut(getArticle(app, ctx.locationId, a.id));
    });
    router.delete('/api/inventory/articles/:id', 'location', (ctx) => {
      const a = getArticle(app, ctx.locationId, ctx.params.id);
      if (db.get('SELECT 1 FROM inv_movements WHERE article_id = ? LIMIT 1', a.id)) throw bad('Der Artikel hat Lagerbewegungen – bitte deaktivieren statt löschen');
      if (db.get('SELECT 1 FROM inv_order_lines WHERE article_id = ? LIMIT 1', a.id)) throw bad('Der Artikel steht in einer Bestellung – bitte deaktivieren statt löschen');
      db.run('DELETE FROM inv_articles WHERE id = ?', a.id);
      return { ok: true };
    });

    // --- movements -------------------------------------------------------------------------------------------------------------
    router.get('/api/inventory/movements', 'location', (ctx) => {
      const where = ['m.location_id = ?'];
      const params: any[] = [ctx.locationId];
      for (const [k, col] of [['article_id', 'm.article_id'], ['type', 'm.type'], ['place_id', 'm.place_id']] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${col} = ?`), params.push(v));
      }
      const from = ctx.query.get('from');
      const to = ctx.query.get('to');
      // days of the sub-account's calendar, not UTC days
      const tz = app.location(ctx.locationId)?.timezone || 'Europe/Berlin';
      const ymd = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
      if (ymd(from)) (where.push('m.created_at >= ?'), params.push(zonedToUtc(from!, '00:00', tz).toISOString()));
      if (ymd(to)) (where.push('m.created_at < ?'), params.push(zonedToUtc(addDaysYmd(to!, 1), '00:00', tz).toISOString()));
      const rows = db.all<any>(
        `SELECT m.*, a.sku, a.name, a.unit, p.name AS place FROM inv_movements m JOIN inv_articles a ON a.id = m.article_id LEFT JOIN inv_places p ON p.id = m.place_id
         WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 200, 1000),
      );
      return rows.map((r) => ({ ...r, type_label: MOVEMENT_LABELS[r.type as MovementType] ?? r.type }));
    });
    router.post('/api/inventory/movements', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (!['receipt', 'issue', 'correction'].includes(b.type)) throw bad('Art: receipt (Wareneingang), issue (Warenausgang) oder correction (Korrektur)');
      const settings = getInvSettings(app, ctx.locationId);
      const r = applyMovement(app, ctx.locationId, {
        article_id: String(b.article_id ?? ''),
        place_id: b.place_id ? String(b.place_id) : null,
        type: b.type,
        qty: num(b.qty, NaN),
        unit_cost_cents: b.unit_cost_cents === undefined || b.unit_cost_cents === null || b.unit_cost_cents === '' ? undefined : num(b.unit_cost_cents, NaN),
        ref_type: 'manual',
        note: str(b.note, 'Notiz', { max: 300 }),
        user_id: userId(ctx),
        allowNegative: settings.allow_negative || b.type === 'correction',
      });
      return { id: r.id, balance: r.balance, low: r.low, article: articleOut(getArticle(app, ctx.locationId, String(b.article_id))) };
    });
    router.post('/api/inventory/transfers', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const r = transferStock(app, ctx.locationId, { article_id: String(b.article_id ?? ''), from_place_id: String(b.from_place_id ?? ''), to_place_id: String(b.to_place_id ?? ''), qty: num(b.qty, NaN), note: str(b.note, 'Notiz', { max: 300 }), user_id: userId(ctx) });
      return { transfer_id: r.transfer_id, article: articleOut(getArticle(app, ctx.locationId, String(b.article_id))) };
    });

    // --- valuation ------------------------------------------------------------------------------------------------------------------
    router.get('/api/inventory/valuation', 'location', (ctx) => {
      const asof = ctx.query.get('asof') || undefined;
      if (asof && !/^\d{4}-\d{2}-\d{2}$/.test(asof)) throw bad('Stichtag als JJJJ-MM-TT angeben');
      const v = valuation(app, ctx.locationId, asof);
      if (ctx.query.get('format') === 'csv') {
        app.services.audit?.({ ctx, action: 'export:inventory/valuation', route: 'GET /api/inventory/valuation', summary: asof ?? 'aktuell' });
        return { __raw: true, status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="Lagerbewertung_${asof ?? today(app, ctx.locationId)}.csv"`, 'cache-control': 'no-store' }, body: semicolonCsv([['Artikelnummer', 'Bezeichnung', 'Einheit', 'Bestand', 'Ø Einkaufspreis', 'Wert'], ...v.rows.map((r) => [r.sku, r.name, r.unit, String(r.qty).replace('.', ','), moneyDe(r.avg_cost_cents), moneyDe(r.value_cents)]), ['', 'Summe', '', '', '', moneyDe(v.total_cents)]]) };
      }
      return v;
    });

    // --- inventory counts -------------------------------------------------------------------------------------------------------------
    router.get('/api/inventory/counts', 'location', (ctx) =>
      db.all(
        `SELECT c.*, p.name AS place, (SELECT COUNT(*) FROM inv_count_lines l WHERE l.count_id = c.id) AS lines, (SELECT COUNT(*) FROM inv_count_lines l WHERE l.count_id = c.id AND l.counted IS NOT NULL) AS counted
         FROM inv_counts c LEFT JOIN inv_places p ON p.id = c.place_id WHERE c.location_id = ? ORDER BY c.created_at DESC LIMIT 100`,
        ctx.locationId,
      ),
    );
    router.post('/api/inventory/counts', 'location', (ctx) => {
      const name = str(ctx.body?.name, 'Name', { max: 120 }) || `Inventur ${today(app, ctx.locationId)}`;
      const cid = startCount(app, ctx.locationId, { name, place_id: ctx.body?.place_id ? String(ctx.body.place_id) : null, user_id: userId(ctx), note: str(ctx.body?.note, 'Notiz', { max: 300 }) });
      return countReport(app, ctx.locationId, cid);
    });
    router.get('/api/inventory/counts/:id', 'location', (ctx) => countReport(app, ctx.locationId, ctx.params.id));
    router.put('/api/inventory/counts/:id/lines', 'location', (ctx) => {
      const c = db.get<any>('SELECT * FROM inv_counts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Inventur nicht gefunden');
      if (c.status !== 'open') throw bad('Diese Inventur ist schon abgeschlossen');
      const lines = ctx.body?.lines;
      if (!Array.isArray(lines) || lines.length > 5000) throw bad('lines: Liste mit höchstens 5000 Zeilen');
      db.tx(() => {
        for (const l of lines) {
          const counted = l?.counted === null || l?.counted === '' ? null : q3(num(l?.counted, NaN));
          if (counted !== null && (!Number.isFinite(counted) || counted < 0 || counted > 1e9)) throw bad('Gezählte Menge ungültig');
          db.run('UPDATE inv_count_lines SET counted = ? WHERE id = ? AND count_id = ? AND location_id = ?', counted, String(l?.id ?? ''), c.id, ctx.locationId);
        }
      });
      return countReport(app, ctx.locationId, c.id);
    });
    router.post('/api/inventory/counts/:id/close', 'location', (ctx) => closeCount(app, ctx.locationId, ctx.params.id, userId(ctx)));
    router.post('/api/inventory/counts/:id/cancel', 'location', (ctx) => {
      const c = db.get<any>('SELECT * FROM inv_counts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound('Inventur nicht gefunden');
      if (c.status !== 'open') throw bad('Diese Inventur ist schon abgeschlossen');
      db.run(`UPDATE inv_counts SET status = 'cancelled', closed_at = ? WHERE id = ?`, now(), c.id);
      return { ok: true };
    });

    // --- purchase orders -----------------------------------------------------------------------------------------------------------------
    const orderOut = (loc: string, oid: string) => {
      const o = db.get<any>('SELECT * FROM inv_orders WHERE id = ? AND location_id = ?', oid, loc);
      if (!o) throw notFound('Bestellung nicht gefunden');
      const lines = db.all<any>(`SELECT l.*, a.sku, a.name, a.unit FROM inv_order_lines l JOIN inv_articles a ON a.id = l.article_id WHERE l.order_id = ? AND l.location_id = ? ORDER BY a.sku`, oid, loc);
      const contact = o.contact_id ? db.get<any>('SELECT first_name, last_name, company, email FROM contacts WHERE id = ? AND location_id = ?', o.contact_id, loc) : undefined;
      return { ...o, contact_name: contact ? contact.company || [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '', contact_email: contact?.email ?? '', lines, total_cents: lines.reduce((n: number, l: any) => n + Math.round(l.qty * l.unit_cost_cents), 0) };
    };
    const nextOrderNumber = (loc: string) => {
      const max = db.all<{ number: string }>('SELECT number FROM inv_orders WHERE location_id = ?', loc).reduce((m, r) => Math.max(m, Number(/(\d+)$/.exec(r.number)?.[1] ?? 0)), 1000);
      return `BE-${max + 1}`;
    };
    const cleanLines = (loc: string, input: unknown) => {
      if (!Array.isArray(input) || !input.length) throw bad('Mindestens eine Position');
      if (input.length > 200) throw bad('Höchstens 200 Positionen');
      return input.map((l: any) => {
        const a = getArticle(app, loc, String(l?.article_id ?? ''));
        const qty = q3(num(l?.qty, NaN));
        if (!Number.isFinite(qty) || qty <= 0 || qty > 1e9) throw bad(`Menge für ${a.sku} muss größer als 0 sein`);
        const cost = l?.unit_cost_cents === undefined || l?.unit_cost_cents === '' ? a.last_cost_cents || a.avg_cost_cents : Math.round(num(l.unit_cost_cents, NaN));
        if (!Number.isFinite(cost) || cost < 0) throw bad('Einkaufspreis ungültig');
        return { article_id: a.id, qty, unit_cost_cents: cost };
      });
    };
    router.get('/api/inventory/orders', 'location', (ctx) => {
      const status = ctx.query.get('status');
      return db.all(
        `SELECT o.*, (SELECT COALESCE(SUM(ROUND(l.qty * l.unit_cost_cents)), 0) FROM inv_order_lines l WHERE l.order_id = o.id) AS total_cents, (SELECT COUNT(*) FROM inv_order_lines l WHERE l.order_id = o.id) AS lines
         FROM inv_orders o WHERE o.location_id = ?${status === 'open' ? ` AND o.status IN ('draft', 'ordered', 'partial')` : status ? ' AND o.status = ?' : ''} ORDER BY o.created_at DESC LIMIT 300`,
        ctx.locationId,
        ...(status && status !== 'open' ? [status] : []),
      );
    });
    router.post('/api/inventory/orders', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const contact = contactOf(ctx.locationId, b.contact_id);
      const supplier = str(b.supplier_name, 'Lieferant', { max: 200 });
      if (!contact && !supplier) throw bad('Bitte einen Lieferanten angeben (Kontakt oder Name)');
      const lines = cleanLines(ctx.locationId, b.lines);
      const oid = id();
      db.tx(() => {
        db.insert('inv_orders', { id: oid, location_id: ctx.locationId, number: nextOrderNumber(ctx.locationId), contact_id: contact, supplier_name: supplier, status: 'draft', expected_at: b.expected_at ? String(b.expected_at).slice(0, 10) : null, notes: str(b.notes, 'Hinweise', { max: 2000 }), created_by: userId(ctx), created_at: now(), updated_at: now() });
        for (const l of lines) db.insert('inv_order_lines', { id: id(), order_id: oid, location_id: ctx.locationId, ...l, received: 0 });
      });
      return orderOut(ctx.locationId, oid);
    });
    router.get('/api/inventory/orders/:id', 'location', (ctx) => orderOut(ctx.locationId, ctx.params.id));
    router.patch('/api/inventory/orders/:id', 'location', (ctx) => {
      const o = db.get<any>('SELECT * FROM inv_orders WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound('Bestellung nicht gefunden');
      if (o.status !== 'draft') throw bad('Nur Entwürfe lassen sich ändern');
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.contact_id !== undefined) patch.contact_id = contactOf(ctx.locationId, b.contact_id);
      if (b.supplier_name !== undefined) patch.supplier_name = str(b.supplier_name, 'Lieferant', { max: 200 });
      if (b.expected_at !== undefined) patch.expected_at = b.expected_at ? String(b.expected_at).slice(0, 10) : null;
      if (b.notes !== undefined) patch.notes = str(b.notes, 'Hinweise', { max: 2000 });
      const lines = b.lines !== undefined ? cleanLines(ctx.locationId, b.lines) : null;
      db.tx(() => {
        db.update('inv_orders', o.id, patch, ctx.locationId);
        if (lines) {
          db.run('DELETE FROM inv_order_lines WHERE order_id = ?', o.id);
          for (const l of lines) db.insert('inv_order_lines', { id: id(), order_id: o.id, location_id: ctx.locationId, ...l, received: 0 });
        }
      });
      return orderOut(ctx.locationId, o.id);
    });
    router.post('/api/inventory/orders/:id/place', 'location', (ctx) => {
      const o = db.get<any>('SELECT * FROM inv_orders WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound('Bestellung nicht gefunden');
      if (o.status !== 'draft') throw bad('Die Bestellung ist schon aufgegeben');
      db.run(`UPDATE inv_orders SET status = 'ordered', ordered_at = ?, updated_at = ? WHERE id = ?`, now(), now(), o.id);
      return orderOut(ctx.locationId, o.id);
    });
    router.post('/api/inventory/orders/:id/send', 'location', async (ctx) => {
      const o = orderOut(ctx.locationId, ctx.params.id);
      if (!o.contact_id) throw bad('Für den E-Mail-Versand braucht die Bestellung einen Lieferanten aus den Kontakten');
      if (!o.contact_email) throw bad('Der Lieferant hat keine E-Mail-Adresse');
      if (o.status === 'cancelled' || o.status === 'received') throw bad('Diese Bestellung ist abgeschlossen');
      const loc = app.location(ctx.locationId)!;
      const list = o.lines.map((l: any, i: number) => `${i + 1}. ${l.sku} – ${l.name}: ${q3(l.qty)} ${l.unit}${l.unit_cost_cents ? ` à ${centsToMoney(l.unit_cost_cents, 'EUR')}` : ''}`).join('\n');
      const body = str(ctx.body?.body, 'Text', { max: 5000 }) || `Guten Tag,\n\nwir bestellen bei Ihnen (Bestellung ${o.number}):\n\n${list}\n${o.expected_at ? `\nGewünschter Liefertermin: ${o.expected_at}\n` : ''}${o.notes ? `\n${o.notes}\n` : ''}\nBitte bestätigen Sie die Bestellung kurz.\n\nViele Grüße\n${loc.name}`;
      const m = await sendToContact(app, ctx.locationId, { contactId: o.contact_id, channel: 'email', subject: str(ctx.body?.subject, 'Betreff', { max: 200 }) || `Bestellung ${o.number} von ${loc.name}`, body, source: 'Bestellung', ignoreDnd: true, userId: userId(ctx) ?? undefined });
      if (m.status === 'failed') throw bad(m.error);
      if (o.status === 'draft') db.run(`UPDATE inv_orders SET status = 'ordered', ordered_at = ?, updated_at = ? WHERE id = ?`, now(), now(), o.id);
      return orderOut(ctx.locationId, o.id);
    });
    router.post('/api/inventory/orders/:id/receive', 'location', (ctx) => {
      const o = db.get<any>('SELECT * FROM inv_orders WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound('Bestellung nicht gefunden');
      if (!['ordered', 'partial', 'draft'].includes(o.status)) throw bad('Für diese Bestellung kann kein Wareneingang gebucht werden');
      const input = ctx.body?.lines;
      if (!Array.isArray(input) || !input.length) throw bad('lines: Mindestens eine Position mit Menge');
      let booked = 0;
      db.tx(() => {
        for (const l of input) {
          const line = db.get<any>('SELECT * FROM inv_order_lines WHERE id = ? AND order_id = ? AND location_id = ?', String(l?.line_id ?? ''), o.id, ctx.locationId);
          if (!line) throw notFound('Position nicht gefunden');
          const qty = q3(num(l?.qty, NaN));
          if (!Number.isFinite(qty) || qty <= 0) continue;
          const cost = l?.unit_cost_cents === undefined || l?.unit_cost_cents === '' ? line.unit_cost_cents : Math.round(num(l.unit_cost_cents, NaN));
          applyMovement(app, ctx.locationId, { article_id: line.article_id, place_id: l?.place_id ? String(l.place_id) : null, type: 'receipt', qty, unit_cost_cents: cost, ref_type: 'po', ref_id: o.id, note: `Bestellung ${o.number}${ctx.body?.note ? `: ${str(ctx.body.note, 'Notiz', { max: 200 })}` : ''}`, user_id: userId(ctx) });
          db.run('UPDATE inv_order_lines SET received = ?, unit_cost_cents = ? WHERE id = ?', q3(line.received + qty), cost, line.id);
          booked++;
        }
        if (!booked) throw bad('Keine Menge gebucht');
        const open = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inv_order_lines WHERE order_id = ? AND received < qty', o.id)?.n ?? 0;
        db.run('UPDATE inv_orders SET status = ?, received_at = ?, updated_at = ? WHERE id = ?', open ? 'partial' : 'received', open ? null : now(), now(), o.id);
      });
      const out = orderOut(ctx.locationId, o.id);
      if (out.status === 'received') app.events.emit(ctx.locationId, 'purchase_order.received', { contactId: out.contact_id ?? undefined, orderId: out.id, number: out.number, supplier: out.supplier_name || out.contact_name, total_cents: out.total_cents });
      return out;
    });
    router.post('/api/inventory/orders/:id/cancel', 'location', (ctx) => {
      const o = db.get<any>('SELECT * FROM inv_orders WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound('Bestellung nicht gefunden');
      if (o.status === 'received' || o.status === 'cancelled') throw bad('Diese Bestellung ist schon abgeschlossen');
      if (db.get('SELECT 1 FROM inv_order_lines WHERE order_id = ? AND received > 0', o.id)) throw bad('Es wurde schon Ware gebucht – die Bestellung lässt sich nicht mehr stornieren');
      db.run(`UPDATE inv_orders SET status = 'cancelled', updated_at = ? WHERE id = ?`, now(), o.id);
      return orderOut(ctx.locationId, o.id);
    });

    // --- automatic goods issue ------------------------------------------------------------------------------------------------------------------
    const syncInvoice = (loc: string, invoiceId: string, force = false) => {
      const settings = getInvSettings(app, loc);
      if (settings.auto_issue_on === 'off' && !force) return undefined;
      const inv = db.get<any>(`SELECT id, number, kind, status, items FROM invoices WHERE id = ? AND location_id = ?`, invoiceId, loc);
      if (!inv || inv.kind !== 'invoice') return undefined;
      const ok = force ? ['sent', 'paid'].includes(inv.status) : settings.auto_issue_on === 'paid' ? inv.status === 'paid' : ['sent', 'paid'].includes(inv.status);
      if (!ok) return undefined;
      try {
        return issueForInvoice(app, loc, inv);
      } catch (e) {
        console.error('[inventory] auto issue', (e as Error).message);
        return undefined;
      }
    };
    app.events.on('invoice.paid', (e) => {
      const invoiceId = e.data?.invoice?.id;
      if (invoiceId) syncInvoice(e.locationId, invoiceId);
    });
    app.afterWrite.push((ctx, route) => {
      if (ctx.locationId && ctx.params.id && route.pattern.startsWith('/api/invoices')) syncInvoice(ctx.locationId, ctx.params.id);
    });
    router.post('/api/inventory/issue-from-invoice/:invoiceId', 'location', (ctx) => {
      const inv = db.get<any>('SELECT id, kind, status FROM invoices WHERE id = ? AND location_id = ?', ctx.params.invoiceId, ctx.locationId);
      if (!inv) throw notFound('Rechnung nicht gefunden');
      if (inv.kind !== 'invoice' || !['sent', 'paid'].includes(inv.status)) throw bad('Nur versendete oder bezahlte Rechnungen können ausgebucht werden');
      return syncInvoice(ctx.locationId, inv.id, true) ?? { issued: [], unmatched: [] };
    });
  },
};
