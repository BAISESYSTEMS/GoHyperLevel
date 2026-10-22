import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { App, Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, num, safeDecode, str } from '../core/http.js';
import { contentMatches, extFor } from '../core/files.js';
import { openSecret } from '../core/secrets.js';
import { id, now, safeEqual, token } from '../core/util.js';
import { chartMap, bookingDate, cleanDate, getEntry, getSettings, postEntry, requireEnabled, trail, type PostingIn } from '../services/acc-ledger.js';
import { completeFields, extractWithAi, findEmbeddedInvoice, parseEInvoice, suggestAccount, supplierKey, type Extraction, type ReceiptLine } from '../services/acc-receipts.js';
import { codeForRate, type TaxCode } from '../services/acc-vat.js';
import { actor, setReceiptKey } from './accounting.js';
import type { Tool } from './mcp.js';

/**
 * Belegeingang: receipts are archived with a SHA-256 hash the moment they arrive (upload, phone photo, forwarded
 * mail), read by the e-invoice parser or the AI (when the sub-account has a vision-capable connection – otherwise by
 * hand), checked by a person and then booked. Archived documents are never changed or deleted (GoBD principle).
 */

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE = /^image\/(png|jpeg|webp|heic)$/;
const XML_TYPES = new Set(['text/xml', 'application/xml']);
export const RECEIPT_MIMES = /^(application\/pdf|image\/(png|jpeg|webp|heic)|text\/xml|application\/xml)$/;

const TOOLS: Tool[] = [
  {
    name: 'ghl_receipt_status',
    title: 'Belegstatus',
    description:
      'Belegeingang der Buchhaltung: Anzahl je Status (inbox = neu, review = ausgelesen, wartet auf Prüfung, booked = gebucht, discarded) und die jüngsten Belege. Mit receipt_id ein einzelner Beleg (Lieferant, Beträge, Konto, gebuchte Buchung). Optional status filtert die Liste.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, receipt_id: { type: 'string' }, status: { type: 'string', enum: ['inbox', 'review', 'booked', 'discarded'] } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      if (a.receipt_id) return call.api('GET', `/api/accounting/receipts/${encodeURIComponent(a.receipt_id)}`, { location: a.location_id });
      return call.api('GET', `/api/accounting/receipts/status${a.status ? `?status=${encodeURIComponent(a.status)}` : ''}`, { location: a.location_id });
    },
  },
];

export const RECEIPT_TRIGGERS = ['receipt.booked', 'receipt.received'];

/** Folder of the archived documents. */
const docDir = (app: App) => join(app.config.dataDir, 'acc-docs');
const docExt = (mime: string) => (XML_TYPES.has(mime) ? '.xml' : extFor(mime));
export const docPath = (app: App, d: { id: string; mime: string }) => join(docDir(app), d.id + docExt(d.mime));

const safeName = (n: string) => String(n || 'beleg').replace(/[\\/\r\n"<>:|?*\u0000-\u001f]/g, '_').slice(0, 150);

/** Archives bytes as a document: type and content are checked, the SHA-256 is recorded, the file is written once. */
export function archiveDocument(app: App, locationId: string, f: { name: string; mime: string; data: Buffer }, user: { id: string | null }, source = 'receipt') {
  const mime = f.mime.toLowerCase();
  if (!RECEIPT_MIMES.test(mime)) throw bad('Nur PDF, Fotos (JPG, PNG, WebP, HEIC) und XML-Rechnungen (XRechnung, ZUGFeRD) werden angenommen');
  if (!f.data.length) throw bad('Die Datei ist leer');
  if (f.data.length > MAX_BYTES) throw bad('Datei größer als 8 MB');
  if (XML_TYPES.has(mime)) {
    const head = f.data.subarray(0, 2048).toString('utf8');
    if (!/^\s*(<\?xml|<)/.test(head) || /<!ENTITY/i.test(f.data.toString('utf8', 0, Math.min(f.data.length, 20000)))) throw bad('Die XML-Datei ist keine gültige Rechnung');
  } else if (!contentMatches(mime, f.data)) throw bad('Dateiinhalt passt nicht zum Dateityp');
  const sha = createHash('sha256').update(f.data).digest('hex');
  const dup = app.db.get<{ id: string }>('SELECT id FROM acc_documents WHERE location_id = ? AND sha256 = ? LIMIT 1', locationId, sha);
  if (dup) return { document: app.db.get<any>('SELECT * FROM acc_documents WHERE id = ?', dup.id)!, duplicate: true };
  const row = { id: id(20), location_id: locationId, name: safeName(f.name), mime, size: f.data.length, sha256: sha, source, created_by: user.id, created_at: now() };
  mkdirSync(docDir(app), { recursive: true });
  writeFileSync(docPath(app, row), f.data, { flag: 'wx' });
  app.db.insert('acc_documents', row);
  return { document: row, duplicate: false };
}

const parseDataUrl = (v: unknown): { mime: string; data: Buffer } => {
  const m = String(v ?? '').match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) throw bad('Erwarte eine data:-URL (Base64)');
  if (m[2].length > MAX_BYTES * 1.4) throw bad('Datei größer als 8 MB');
  return { mime: m[1], data: Buffer.from(m[2], 'base64') };
};

interface ReceiptRow {
  id: string;
  location_id: string;
  document_id: string | null;
  status: string;
  source: string;
  supplier: string;
  supplier_key: string;
  supplier_vat_id: string;
  invoice_no: string;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  net_cents: number | null;
  vat_cents: number | null;
  gross_cents: number | null;
  vat_rate: number | null;
  reverse_charge: number;
  credit_note: number;
  lines: string;
  account: string;
  payment: string;
  extraction: string;
  iban: string;
  contact_id: string | null;
  entry_id: string | null;
  payment_entry_id: string | null;
  bank_txn_id: string | null;
  note: string;
  from_email: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const json = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

export const receiptOut = (r: ReceiptRow) => ({ ...r, reverse_charge: !!r.reverse_charge, credit_note: !!r.credit_note, lines: json<ReceiptLine[]>(r.lines, []), extraction: json<any>(r.extraction, {}) });

const FIELD_COLS = ['supplier', 'supplier_vat_id', 'invoice_no', 'invoice_date', 'due_date', 'currency', 'net_cents', 'vat_cents', 'gross_cents', 'vat_rate', 'reverse_charge', 'credit_note', 'iban', 'account'] as const;

/** Writes extracted values into the receipt – only into fields that are still empty, unless `force`. */
function applyExtraction(app: App, locationId: string, receiptId: string, ex: Extraction, opts: { force?: boolean; status?: boolean } = {}) {
  const r = app.db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', receiptId, locationId);
  if (!r || r.status === 'booked' || r.status === 'discarded') return;
  const patch: Record<string, any> = {};
  const f = ex.fields as Record<string, any>;
  for (const k of FIELD_COLS) {
    const v = f[k];
    if (v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))) continue;
    const cur = (r as any)[k];
    const empty = cur === null || cur === '' || cur === 0 || cur === undefined;
    if (opts.force || empty) patch[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  if (f.lines?.length && (opts.force || r.lines === '[]')) patch.lines = JSON.stringify(f.lines);
  if (patch.supplier) patch.supplier_key = supplierKey(patch.supplier);
  const supplier = String(patch.supplier ?? r.supplier);
  if (!patch.account && !r.account && supplier) {
    const chart = chartMap(app, locationId);
    const sug = suggestAccount(app, locationId, supplier, '', getSettings(app, locationId).standard, chart);
    if (sug) {
      patch.account = sug.account;
      ex = { ...ex, warnings: ex.warnings, note: [ex.note, `Konto: ${sug.reason}`].filter(Boolean).join(' – ') };
    }
  }
  patch.extraction = JSON.stringify({ method: ex.method, model: ex.model ?? '', warnings: ex.warnings, note: ex.note ?? '', status: 'done', at: now() });
  if (opts.status !== false && (patch.gross_cents || patch.net_cents || r.gross_cents)) patch.status = r.status === 'inbox' ? 'review' : r.status;
  patch.updated_at = now();
  app.db.update('acc_receipts', receiptId, patch, locationId);
}

export const receiptsModule: Module = {
  name: 'accounting-receipts',
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...RECEIPT_TRIGGERS];

    // AI reads run in the background (see app.services.accountingFlush).
    const pending: Set<Promise<void>> = app.services.accountingPending;

    const docRow = (loc: string, docId: string | null) => (docId ? db.get<any>('SELECT * FROM acc_documents WHERE id = ? AND location_id = ?', docId, loc) : undefined);

    /** Reads the receipt: e-invoice first (exact), then the AI (background) – or nothing, for manual entry. */
    async function extract(loc: string, receiptId: string, opts: { force?: boolean; ai?: boolean } = {}): Promise<Extraction | { unavailable: string }> {
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', receiptId, loc);
      const d = r && docRow(loc, r.document_id);
      if (!r || !d) throw notFound('Beleg nicht gefunden');
      const path = docPath(app, d);
      if (!existsSync(path)) throw new HttpError(410, 'Die archivierte Datei fehlt auf dem Server');
      const data = readFileSync(path);
      let ex: Extraction | null = null;
      if (XML_TYPES.has(d.mime)) ex = parseEInvoice(data.toString('utf8'));
      else if (d.mime === 'application/pdf') {
        const xml = findEmbeddedInvoice(data);
        const parsed = xml ? parseEInvoice(xml) : null;
        if (parsed) ex = { ...parsed, method: 'zugferd' };
      }
      if (ex) {
        applyExtraction(app, loc, receiptId, ex, { force: opts.force });
        return ex;
      }
      if (XML_TYPES.has(d.mime)) {
        db.run('UPDATE acc_receipts SET extraction = ?, updated_at = ? WHERE id = ?', JSON.stringify({ method: 'manual', status: 'failed', warnings: ['Die XML-Datei ist keine bekannte E-Rechnung (XRechnung/ZUGFeRD).'] }), now(), receiptId);
        return { unavailable: 'Die XML-Datei ist keine bekannte E-Rechnung – bitte von Hand eintragen.' };
      }
      if (opts.ai === false) {
        db.run('UPDATE acc_receipts SET extraction = ?, updated_at = ? WHERE id = ?', JSON.stringify({ method: 'manual', status: 'manual', note: 'Automatisches Auslesen ist ausgeschaltet.' }), now(), receiptId);
        return { unavailable: 'Automatisches Auslesen ist ausgeschaltet (Einstellungen).' };
      }
      const ai = await extractWithAi(app, loc, { mime: d.mime, data, name: d.name }, [...chartMap(app, loc).values()]);
      if (ai.extraction) {
        applyExtraction(app, loc, receiptId, ai.extraction, { force: opts.force });
        return ai.extraction;
      }
      db.run('UPDATE acc_receipts SET extraction = ?, updated_at = ? WHERE id = ?', JSON.stringify({ method: 'manual', status: 'manual', warnings: [], note: ai.unavailable }), now(), receiptId);
      return { unavailable: ai.unavailable ?? 'Nicht lesbar' };
    }

    const background = (loc: string, receiptId: string, ai: boolean) => {
      const p: Promise<void> = extract(loc, receiptId, { ai }).then(
        () => undefined,
        (e) => console.error('[accounting] extract', (e as Error).message),
      );
      pending.add(p);
      void p.finally(() => pending.delete(p));
    };

    /** New receipt for an archived document (sync e-invoice read, AI in the background). */
    function createReceipt(loc: string, f: { name: string; mime: string; data: Buffer }, o: { source: string; user: { id: string | null }; note?: string; from?: string }) {
      requireEnabled(app, loc);
      const { document, duplicate } = archiveDocument(app, loc, f, o.user);
      const existing = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE location_id = ? AND document_id = ?', loc, document.id);
      if (existing) return { receipt: receiptOut(existing), duplicate: true };
      const row = {
        id: id(),
        location_id: loc,
        document_id: document.id,
        status: 'inbox',
        source: o.source,
        note: String(o.note ?? '').slice(0, 500),
        from_email: String(o.from ?? '').slice(0, 200),
        extraction: JSON.stringify({ status: 'pending' }),
        created_by: o.user.id,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('acc_receipts', row);
      trail(app, loc, { id: o.user.id, name: o.from || 'Beleg-Eingang' }, 'receipt.archive', null, `${document.name} (${document.sha256.slice(0, 12)}…)${duplicate ? ' – Dublette der Datei' : ''}`);
      const xmlish = XML_TYPES.has(document.mime) || document.mime === 'application/pdf';
      const settings = getSettings(app, loc);
      // E-invoices are exact and free: read right away (a PDF without XML inside waits for the AI like a photo).
      if (xmlish || (settings.receipts.auto_extract && IMAGE.test(document.mime))) background(loc, row.id, settings.receipts.auto_extract);
      else db.run('UPDATE acc_receipts SET extraction = ? WHERE id = ?', JSON.stringify({ method: 'manual', status: 'manual' }), row.id);
      app.events.emit(loc, 'receipt.received', { receiptId: row.id, source: o.source, file: document.name });
      return { receipt: receiptOut(db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ?', row.id)!), duplicate: false };
    }

    // --- list / read -------------------------------------------------------------------------------------------------
    router.get('/api/accounting/receipts/status', 'location', (ctx) => {
      const counts = Object.fromEntries(db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM acc_receipts WHERE location_id = ? GROUP BY status', ctx.locationId).map((r) => [r.status, r.n]));
      const status = ctx.query.get('status');
      const rows = db.all<ReceiptRow>(`SELECT * FROM acc_receipts WHERE location_id = ?${status ? ' AND status = ?' : ''} ORDER BY created_at DESC LIMIT 20`, ctx.locationId, ...(status ? [status] : []));
      return {
        counts: { inbox: counts.inbox ?? 0, review: counts.review ?? 0, booked: counts.booked ?? 0, discarded: counts.discarded ?? 0 },
        receipts: rows.map((r) => ({ id: r.id, status: r.status, supplier: r.supplier, invoice_no: r.invoice_no, invoice_date: r.invoice_date, gross_cents: r.gross_cents, account: r.account, entry_id: r.entry_id, created_at: r.created_at, extraction_method: json<any>(r.extraction, {}).method ?? '' })),
      };
    });
    router.get('/api/accounting/receipts', 'location', (ctx) => {
      const where = ['r.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const status = ctx.query.get('status');
      if (status === 'open') where.push(`r.status IN ('inbox', 'review')`);
      else if (status) (where.push('r.status = ?'), params.push(status));
      else where.push(`r.status != 'discarded'`);
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push('(r.supplier LIKE ? OR r.invoice_no LIKE ? OR r.note LIKE ?)'), params.push(`%${q}%`, `%${q}%`, `%${q}%`));
      const rows = db.all<ReceiptRow & { doc_name: string; doc_mime: string; doc_sha: string }>(
        `SELECT r.*, d.name AS doc_name, d.mime AS doc_mime, d.sha256 AS doc_sha FROM acc_receipts r LEFT JOIN acc_documents d ON d.id = r.document_id
         WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 200, 500),
      );
      return rows.map((r) => ({ ...receiptOut(r), doc_name: r.doc_name, doc_mime: r.doc_mime, doc_sha: r.doc_sha }));
    });
    router.get('/api/accounting/receipts/:id', 'location', (ctx) => {
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Beleg nicht gefunden');
      const d = docRow(ctx.locationId, r.document_id);
      const entry = r.entry_id ? getEntry(app, ctx.locationId, r.entry_id) : undefined;
      return { ...receiptOut(r), document: d && { id: d.id, name: d.name, mime: d.mime, size: d.size, sha256: d.sha256, created_at: d.created_at, url: `/api/accounting/documents/${d.id}` }, entry: entry && { id: entry.id, number: entry.number, date: entry.date } };
    });

    // --- upload ---------------------------------------------------------------------------------------------------------
    router.post('/api/accounting/receipts', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const url = parseDataUrl(b.data);
      const a = actor(ctx);
      const out = createReceipt(ctx.locationId, { name: str(b.name, 'Dateiname', { required: true, max: 200 }), mime: url.mime, data: url.data }, { source: b.source === 'mobile' ? 'mobile' : 'upload', user: a, note: str(b.note, 'Notiz', { max: 500 }) });
      return out;
    });

    router.patch('/api/accounting/receipts/:id', 'location', (ctx) => {
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Beleg nicht gefunden');
      if (r.status === 'booked') throw bad('Der Beleg ist gebucht – bitte die Buchung stornieren, um ihn zu ändern');
      if (r.status === 'discarded') throw bad('Der Beleg wurde verworfen');
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      for (const k of ['supplier', 'supplier_vat_id', 'invoice_no', 'iban', 'note']) if (b[k] !== undefined) patch[k] = str(b[k], k, { max: k === 'note' ? 500 : 200 });
      if (patch.supplier !== undefined) patch.supplier_key = supplierKey(patch.supplier);
      for (const k of ['invoice_date', 'due_date'] as const) if (b[k] !== undefined) patch[k] = b[k] ? cleanDate(b[k], k === 'invoice_date' ? 'Rechnungsdatum' : 'Fälligkeit') : null;
      for (const k of ['net_cents', 'vat_cents', 'gross_cents'] as const) {
        if (b[k] === undefined) continue;
        if (b[k] === null || b[k] === '') patch[k] = null;
        else {
          const n = Math.round(num(b[k], NaN));
          if (!Number.isFinite(n) || n < 0 || n > 99_999_999_999) throw bad('Betrag ungültig');
          patch[k] = n;
        }
      }
      if (b.vat_rate !== undefined) patch.vat_rate = b.vat_rate === null || b.vat_rate === '' ? null : num(b.vat_rate, 0);
      for (const k of ['reverse_charge', 'credit_note'] as const) if (b[k] !== undefined) patch[k] = b[k] ? 1 : 0;
      if (b.currency !== undefined) patch.currency = /^[A-Z]{3}$/.test(String(b.currency)) ? String(b.currency) : 'EUR';
      if (b.account !== undefined) {
        const acc = b.account ? chartMap(app, ctx.locationId).get(String(b.account)) : undefined;
        if (b.account && (!acc || !acc.active)) throw bad(`Konto ${String(b.account)} gibt es nicht`);
        patch.account = b.account ? String(b.account) : '';
      }
      if (b.payment !== undefined) {
        if (!['open', 'bank', 'cash', 'private'].includes(b.payment)) throw bad('Zahlung: open, bank, cash oder private');
        patch.payment = b.payment;
      }
      if (b.contact_id !== undefined) patch.contact_id = b.contact_id ? String(b.contact_id) : null;
      if (b.lines !== undefined) {
        if (!Array.isArray(b.lines) || b.lines.length > 20) throw bad('Positionen: höchstens 20');
        patch.lines = JSON.stringify(b.lines.map((l: any) => ({ net_cents: Math.max(0, Math.round(num(l?.net_cents, 0))), vat_rate: num(l?.vat_rate, 0), vat_cents: Math.max(0, Math.round(num(l?.vat_cents, 0))), ...(l?.account ? { account: String(l.account) } : {}) })));
      } else if (['net_cents', 'vat_cents', 'gross_cents', 'vat_rate'].some((k) => b[k] !== undefined)) {
        // One line follows the totals.
        const merged = { ...r, ...patch } as any;
        const done = completeFields({ net_cents: merged.net_cents ?? undefined, vat_cents: merged.vat_cents ?? undefined, gross_cents: merged.gross_cents ?? undefined, vat_rate: merged.vat_rate ?? undefined, reverse_charge: !!merged.reverse_charge });
        for (const k of ['net_cents', 'vat_cents', 'gross_cents', 'vat_rate'] as const) if (done.fields[k] !== undefined && merged[k] === null) patch[k] = done.fields[k];
        const f = done.fields;
        patch.lines = JSON.stringify(f.net_cents !== undefined ? [{ net_cents: f.net_cents, vat_rate: f.vat_rate ?? 0, vat_cents: f.vat_cents ?? 0 }] : []);
      }
      if (r.status === 'inbox' && (patch.gross_cents || patch.net_cents)) patch.status = 'review';
      db.update('acc_receipts', r.id, patch, ctx.locationId);
      return receiptOut(db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ?', r.id)!);
    });

    router.post('/api/accounting/receipts/:id/extract', 'location', async (ctx) => {
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Beleg nicht gefunden');
      if (r.status === 'booked' || r.status === 'discarded') throw bad('Dieser Beleg ist abgeschlossen');
      const out = await extract(ctx.locationId, r.id, { force: ctx.body?.overwrite === true });
      return { ...('unavailable' in out ? { ok: false, message: out.unavailable } : { ok: true, method: out.method, warnings: out.warnings }), receipt: receiptOut(db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ?', r.id)!) };
    });

    router.post('/api/accounting/receipts/:id/discard', 'location', (ctx) => {
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Beleg nicht gefunden');
      if (r.status === 'booked') throw bad('Gebuchte Belege lassen sich nicht verwerfen – bitte die Buchung stornieren');
      // The file and its hash stay archived; the receipt only leaves the inbox.
      db.run(`UPDATE acc_receipts SET status = 'discarded', note = ?, updated_at = ? WHERE id = ?`, str(ctx.body?.reason, 'Grund', { max: 300 }) || r.note, now(), r.id);
      trail(app, ctx.locationId, actor(ctx), 'receipt.discard', null, `${r.supplier || r.id}: ${str(ctx.body?.reason, 'Grund', { max: 200 })}`);
      return { ok: true };
    });

    // --- booking -----------------------------------------------------------------------------------------------------------
    router.post('/api/accounting/receipts/:id/book', 'location', (ctx) => {
      const settings = requireEnabled(app, ctx.locationId);
      const r = db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!r) throw notFound('Beleg nicht gefunden');
      if (r.status === 'booked') throw bad('Dieser Beleg ist schon gebucht');
      if (r.status === 'discarded') throw bad('Dieser Beleg wurde verworfen');
      const b = ctx.body ?? {};
      const chart = chartMap(app, ctx.locationId);
      const accountNo = String(b.account ?? r.account ?? '').trim();
      const expense = chart.get(accountNo);
      if (!expense || !expense.active) throw bad('Bitte ein Konto wählen (Aufwand oder Anlage)');
      if (expense.type !== 'expense' && expense.type !== 'asset') throw bad(`Konto ${accountNo} ist kein Aufwands- oder Anlagekonto`);
      if (!r.invoice_date) throw bad('Rechnungsdatum fehlt');
      const docDate = cleanDate(r.invoice_date, 'Rechnungsdatum');
      const payment = String(b.payment ?? r.payment ?? 'open');
      const counter = { open: settings.mapping.payable, bank: settings.mapping.bank, cash: settings.mapping.cash, private: settings.mapping.private_deposit }[payment];
      if (!counter) throw bad('Zahlung: open, bank, cash oder private');
      const rc = !!r.reverse_charge;
      const lines: (ReceiptLine & { account?: string })[] = json(r.lines, []);
      const use: (ReceiptLine & { account?: string })[] = lines.length ? lines : r.net_cents !== null ? [{ net_cents: r.net_cents, vat_rate: r.vat_rate ?? 0, vat_cents: r.vat_cents ?? 0 }] : r.gross_cents ? [{ net_cents: r.gross_cents, vat_rate: 0, vat_cents: 0 }] : [];
      if (!use.length || !use.some((l) => l.net_cents > 0)) throw bad('Betrag fehlt');
      if (r.currency !== 'EUR') throw bad(`Der Beleg ist in ${r.currency} – bitte erst den Eurobetrag eintragen`);
      const credit = !!r.credit_note;
      const postings: PostingIn[] = use.filter((l) => l.net_cents > 0).map((l) => {
        const code: TaxCode = rc ? 'rc19' : (() => { try { return codeForRate(l.vat_rate, 'input'); } catch { return 'vst0'; } })();
        if (!rc && ![0, 7, 19].includes(l.vat_rate)) throw bad(`Steuersatz ${l.vat_rate} % wird nicht unterstützt (19, 7 oder 0) – bitte als Buchung von Hand erfassen`);
        const lineAcc = l.account && chart.get(l.account)?.active ? l.account : accountNo;
        const gross = rc ? l.net_cents : l.net_cents + l.vat_cents;
        // Credit note from the supplier: the same posting the other way round.
        // Net and tax as the supplier printed them (rounding included); reverse charge computes its own tax from the net.
        return { debit: credit ? counter : lineAcc, credit: credit ? lineAcc : counter, amount_cents: gross, ...(rc ? {} : { net_cents: l.net_cents, tax_cents: l.vat_cents }), tax_code: code, text: `${r.supplier || 'Beleg'} ${r.invoice_no}`.trim() };
      });
      const a = actor(ctx);
      const date = b.date ? cleanDate(b.date, 'Buchungsdatum') : bookingDate(app, ctx.locationId, docDate);
      const { entry } = postEntry(app, ctx.locationId, {
        date,
        doc_date: docDate,
        due_date: r.due_date,
        text: `${r.supplier || 'Beleg'}${r.invoice_no ? `: ${r.invoice_no}` : ''}`,
        doc_ref: r.invoice_no || `BELEG-${r.id.slice(0, 8)}`,
        source: 'receipt',
        source_id: r.id,
        source_key: `receipt:${r.id}`,
        postings,
        party_name: r.supplier,
        contact_id: b.contact_id ?? r.contact_id,
        receipt_id: r.id,
        document_id: r.document_id,
        user_id: a.id,
        actor: a.name,
      });
      db.run(`UPDATE acc_receipts SET status = 'booked', entry_id = ?, account = ?, payment = ?, updated_at = ? WHERE id = ?`, entry.id, accountNo, payment, now(), r.id);
      app.events.emit(ctx.locationId, 'receipt.booked', { contactId: b.contact_id ?? r.contact_id ?? undefined, receiptId: r.id, entryId: entry.id, entryNumber: entry.number, supplier: r.supplier, invoiceNo: r.invoice_no, gross_cents: r.gross_cents, account: accountNo, payment });
      return { ok: true, entry, receipt: receiptOut(db.get<ReceiptRow>('SELECT * FROM acc_receipts WHERE id = ?', r.id)!) };
    });

    // --- archived documents ---------------------------------------------------------------------------------------------------
    router.get('/api/accounting/documents/:id', 'location', (ctx) => {
      const d = docRow(ctx.locationId, ctx.params.id);
      const path = d && docPath(app, d);
      if (!d || !path || !existsSync(path)) throw notFound('Beleg nicht gefunden');
      const inline = d.mime === 'application/pdf' || IMAGE.test(d.mime);
      return {
        __raw: true,
        status: 200,
        headers: {
          'content-type': XML_TYPES.has(d.mime) ? 'application/xml; charset=utf-8' : d.mime,
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${d.name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(d.name)}`,
          'x-content-type-options': 'nosniff',
          'x-document-sha256': d.sha256,
          'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
          'cache-control': 'private, max-age=3600',
        },
        body: readFileSync(path),
      };
    });
    router.get('/api/accounting/documents/:id/verify', 'location', (ctx) => {
      const d = docRow(ctx.locationId, ctx.params.id);
      if (!d) throw notFound('Beleg nicht gefunden');
      const path = docPath(app, d);
      const ok = existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === d.sha256;
      return { id: d.id, name: d.name, sha256: d.sha256, ok, missing: !existsSync(path) };
    });

    // --- forwarding by mail -----------------------------------------------------------------------------------------------------
    const inboundKey = (loc: string): string | undefined => {
      const row = db.get<{ receipt_key: string | null }>('SELECT receipt_key FROM acc_settings WHERE location_id = ?', loc);
      if (!row?.receipt_key) return undefined;
      try {
        return openSecret(app, row.receipt_key);
      } catch {
        return undefined;
      }
    };
    router.get('/api/accounting/inbound', 'location', (ctx) => {
      let key = inboundKey(ctx.locationId);
      if (!key) {
        key = token(18);
        setReceiptKey(app, ctx.locationId, key);
      }
      return { url: `${app.baseUrl()}/hooks/${ctx.locationId}/receipts?key=${key}`, allowed_senders: getSettings(app, ctx.locationId).receipts.allowed_senders };
    });
    router.post('/api/accounting/inbound/rotate', 'location', (ctx) => {
      const key = token(18);
      setReceiptKey(app, ctx.locationId, key);
      trail(app, ctx.locationId, actor(ctx), 'inbound.rotate', null, 'Schlüssel für die Beleg-Weiterleitung erneuert');
      return { url: `${app.baseUrl()}/hooks/${ctx.locationId}/receipts?key=${key}` };
    });
    // Mail-forwarding services (Cloudflare Email Workers, Make, Zapier, n8n) post the attachments here as JSON.
    app.services.bodyLimits = [
      ...(app.services.bodyLimits ?? []),
      {
        match: (m: string, p: string, req: { url?: string }) => {
          const hit = m === 'POST' && /^\/hooks\/([^/]+)\/receipts$/.exec(p);
          if (!hit) return false;
          const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key');
          const real = inboundKey(safeDecode(hit[1]));
          return !!key && !!real && safeEqual(key, real);
        },
        bytes: 24 * 1024 * 1024,
      },
    ];
    router.post('/hooks/:loc/receipts', 'public', (ctx) => {
      const loc = ctx.params.loc;
      const real = inboundKey(loc);
      if (!real || !app.location(loc) || !safeEqual(ctx.query.get('key'), real)) throw new HttpError(401, 'Falscher Schlüssel');
      const settings = getSettings(app, loc);
      if (!settings.enabled) throw new HttpError(409, 'Die Buchhaltung ist nicht eingerichtet');
      const b = ctx.body ?? {};
      const rawFrom = String(b.from ?? b.sender ?? b.From ?? '');
      const from = (rawFrom.match(/<([^>]+)>/)?.[1] ?? rawFrom).trim().toLowerCase();
      const allowed = settings.receipts.allowed_senders;
      if (allowed.length && !allowed.some((s) => (s.startsWith('@') ? from.endsWith(s) : from === s))) throw new HttpError(403, 'Absender nicht freigegeben');
      const atts: any[] = Array.isArray(b.attachments) ? b.attachments : Array.isArray(b.files) ? b.files : [];
      if (!atts.length) throw bad('Keine Anhänge');
      const created: string[] = [];
      const skipped: string[] = [];
      for (const att of atts.slice(0, 10)) {
        const name = String(att?.filename ?? att?.name ?? 'beleg').slice(0, 150);
        let mime = String(att?.content_type ?? att?.contentType ?? att?.mime ?? '').split(';')[0].trim().toLowerCase();
        let data: Buffer;
        try {
          const c = String(att?.content ?? att?.data ?? '');
          const m = c.match(/^data:([\w/+.-]+);base64,(.+)$/s);
          if (m) (mime = mime || m[1], (data = Buffer.from(m[2], 'base64')));
          else data = Buffer.from(c.replace(/\s+/g, ''), 'base64');
        } catch {
          skipped.push(name);
          continue;
        }
        if (!RECEIPT_MIMES.test(mime)) {
          skipped.push(name);
          continue;
        }
        try {
          const out = createReceipt(loc, { name, mime, data }, { source: 'email', user: { id: null }, from: from || 'E-Mail', note: String(b.subject ?? '').slice(0, 200) });
          if (!out.duplicate) created.push(out.receipt.id);
        } catch (e) {
          skipped.push(`${name}: ${(e as Error).message}`);
        }
      }
      app.services.audit?.({ action: 'accounting.receipt.inbound', locationId: loc, actor: from || 'E-Mail', summary: `${created.length} ${created.length === 1 ? 'Beleg' : 'Belege'} per E-Mail, ${skipped.length} übersprungen`.slice(0, 200) });
      return { ok: true, created: created.length, skipped };
    });
  },
};
