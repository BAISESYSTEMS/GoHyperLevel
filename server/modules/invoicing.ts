import { existsSync, readFileSync } from 'node:fs';
import type { Module, App } from '../core/app.js';
import { HttpError, bad, notFound, str, type RawResult } from '../core/http.js';
import { sealSettings } from '../core/secrets.js';
import {
  RANGE_KEYS,
  RANGE_LABELS,
  TAX_MODES,
  UNITS,
  cleanRange,
  checkBic,
  checkIban,
  checkVatId,
  FROZEN_COLUMNS,
  isTaxMode,
  normalizeIban,
  rangeCfg,
  rangePeriod,
  type RangeKey,
} from '../services/invoice-model.js';
import {
  actorOf,
  adoptStragglers,
  backfillSnapshots,
  billingSettings,
  convertEstimate,
  createCreditNote,
  invAudit,
  mustInvoice,
  precheck,
  rangeStatus,
  recordPayment,
  revertPayment,
  stornoInvoice,
  tzOf,
  verifyInvoice,
} from '../services/invoice-flow.js';
import { archiveEinvoice, archivedFile, einvoiceOf, einvoiceReport, invoicePdfOf } from '../services/invoice-render.js';
import { viesCheck } from '../services/vies.js';
import { mergeSettings } from './core.js';
import { finaliseChecked, invoiceOut, sendInvoice } from './payments.js';
import { ymdInTz } from '../core/time.js';

/**
 * GoBD-style invoicing on top of the invoices of modules/payments.ts: finalising (gap-free number, frozen content, snapshot
 * and SHA-256), Storno and credit notes, quote → invoice, partial payments, PDF and XRechnung downloads with an immutable
 * archive copy, the number ranges and the VAT-ID check. The tables hold what the old invoices table never had: counters,
 * payments, an append-only audit trail and the archive links; triggers keep a finalised invoice from changing.
 */

const FROZEN = FROZEN_COLUMNS.filter((c) => c !== 'snapshot' && c !== 'doc_hash');

export const GOBD_SQL = `
ALTER TABLE invoices ADD COLUMN finalised_at TEXT;
ALTER TABLE invoices ADD COLUMN finalised_by TEXT;
ALTER TABLE invoices ADD COLUMN doc_hash TEXT;
ALTER TABLE invoices ADD COLUMN snapshot TEXT;
ALTER TABLE invoices ADD COLUMN tax_mode TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE invoices ADD COLUMN tax_note TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN supply_from TEXT;
ALTER TABLE invoices ADD COLUMN supply_to TEXT;
ALTER TABLE invoices ADD COLUMN buyer_vat_id TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN leitweg_id TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN buyer_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN skonto_percent REAL;
ALTER TABLE invoices ADD COLUMN skonto_days INTEGER;
ALTER TABLE invoices ADD COLUMN inv_type TEXT NOT NULL DEFAULT 'standard';
ALTER TABLE invoices ADD COLUMN credit_type TEXT NOT NULL DEFAULT '';
ALTER TABLE invoices ADD COLUMN ref_id TEXT;
ALTER TABLE invoices ADD COLUMN deduct_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE invoices ADD COLUMN deducted_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN paid_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN credited_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN cancelled_at TEXT;
ALTER TABLE invoices ADD COLUMN storno_id TEXT;
ALTER TABLE invoices ADD COLUMN calc TEXT NOT NULL DEFAULT 'line';
ALTER TABLE invoices ADD COLUMN issued_auto INTEGER NOT NULL DEFAULT 0;

-- Existing documents: tax treatment recognised from what the old versions stored
UPDATE invoices SET tax_mode = 'small_business', tax_note = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'
 WHERE tax_cents = 0 AND EXISTS (SELECT 1 FROM locations l WHERE l.id = invoices.location_id AND json_extract(l.settings, '$.invoices.small_business') IN (1, 'true'));
UPDATE invoices SET tax_mode = 'reverse_charge', tax_note = 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge) gemäß § 13b UStG bzw. Art. 196 MwStSystRL.'
 WHERE tax_mode = 'standard' AND tax_cents = 0 AND total_cents > 0 AND kind != 'estimate'
   AND (lower(title || ' ' || notes) LIKE '%reverse%charge%' OR lower(title || ' ' || notes) LIKE '%13b%' OR lower(title || ' ' || notes) LIKE '%steuerschuldnerschaft%');
-- Drafts get no number any more (a placeholder keeps the unique key), sent / paid / cancelled invoices are finalised with the number they have
UPDATE invoices SET number = 'Entwurf-' || id WHERE kind = 'invoice' AND status = 'draft';
UPDATE invoices SET calc = 'group' WHERE status = 'draft' OR kind = 'estimate';
UPDATE invoices SET finalised_at = COALESCE(sent_at, issued_at) WHERE kind = 'invoice' AND status IN ('sent', 'paid', 'void');
UPDATE invoices SET paid_cents = total_cents WHERE kind = 'invoice' AND status = 'paid';
CREATE INDEX invoices_ref ON invoices(ref_id);
CREATE INDEX invoices_unhashed ON invoices(location_id) WHERE finalised_at IS NOT NULL AND doc_hash IS NULL;
CREATE INDEX invoices_unadopted ON invoices(location_id) WHERE finalised_at IS NULL AND status != 'draft' AND kind != 'estimate';

CREATE TABLE invoice_counters (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, range TEXT NOT NULL, period TEXT NOT NULL DEFAULT '', last INTEGER NOT NULL,
  PRIMARY KEY (location_id, range, period)
);
CREATE TABLE invoice_payments (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL, paid_at TEXT NOT NULL, method TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'payment', reverses_id TEXT, source TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX invoice_payments_invoice ON invoice_payments(invoice_id, created_at);
CREATE TABLE invoice_audit (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, invoice_id TEXT,
  at TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'System', user_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX invoice_audit_invoice ON invoice_audit(invoice_id, at);
CREATE INDEX invoice_audit_location ON invoice_audit(location_id, at);
CREATE TABLE invoice_documents (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, document_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, retention_until TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX invoice_documents_invoice ON invoice_documents(invoice_id, created_at);

-- Numbers already given out continue where they stopped: the counter of the invoice range starts at the highest number in the old prefix
INSERT INTO invoice_counters (location_id, range, period, last)
SELECT i.location_id, 'invoice', '', MAX(CAST(SUBSTR(i.number, LENGTH(p.prefix) + 1) AS INTEGER))
  FROM invoices i JOIN (SELECT id, COALESCE(json_extract(settings, '$.invoices.prefix'), 'RE-') AS prefix FROM locations) p ON p.id = i.location_id
 WHERE i.kind = 'invoice' AND i.finalised_at IS NOT NULL AND SUBSTR(i.number, 1, LENGTH(p.prefix)) = p.prefix
   AND SUBSTR(i.number, LENGTH(p.prefix) + 1) != '' AND SUBSTR(i.number, LENGTH(p.prefix) + 1) NOT GLOB '*[^0-9]*'
 GROUP BY i.location_id;

-- A finalised invoice cannot change: content, amounts, parties, number and date are frozen; note, due date, payment link and status handling stay open
CREATE TRIGGER invoices_frozen BEFORE UPDATE OF ${FROZEN.join(', ')} ON invoices
WHEN OLD.finalised_at IS NOT NULL AND (${FROZEN.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(' OR ')})
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: der Inhalt kann nicht mehr geändert werden'); END;
CREATE TRIGGER invoices_frozen_contact BEFORE UPDATE OF contact_id ON invoices
WHEN OLD.finalised_at IS NOT NULL AND NEW.contact_id IS NOT NULL AND NEW.contact_id IS NOT OLD.contact_id
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: der Kunde kann nicht mehr gewechselt werden'); END;
CREATE TRIGGER invoices_frozen_snapshot BEFORE UPDATE OF snapshot, doc_hash ON invoices
WHEN OLD.finalised_at IS NOT NULL AND OLD.doc_hash IS NOT NULL AND (NEW.snapshot IS NOT OLD.snapshot OR NEW.doc_hash IS NOT OLD.doc_hash)
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: Momentaufnahme und Prüfsumme sind unveränderlich'); END;
CREATE TRIGGER invoices_no_reopen BEFORE UPDATE OF status ON invoices
WHEN OLD.finalised_at IS NOT NULL AND (NEW.status = 'draft' OR (OLD.status = 'void' AND NEW.status != 'void'))
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnung: nicht zurück in den Entwurf, eine stornierte bleibt storniert'); END;
CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
WHEN OLD.finalised_at IS NOT NULL AND EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Rechnungen werden nicht gelöscht (Aufbewahrungspflicht) – stornieren statt löschen'); END;
CREATE TRIGGER invoice_audit_no_update BEFORE UPDATE ON invoice_audit BEGIN SELECT RAISE(ABORT, 'Das Rechnungsprotokoll ist unveränderlich'); END;
CREATE TRIGGER invoice_audit_no_delete BEFORE DELETE ON invoice_audit WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id) BEGIN SELECT RAISE(ABORT, 'Das Rechnungsprotokoll ist unveränderlich'); END;
CREATE TRIGGER invoice_payments_no_update BEFORE UPDATE ON invoice_payments BEGIN SELECT RAISE(ABORT, 'Zahlungen sind unveränderlich – eine falsche Zahlung wird zurückgenommen'); END;
CREATE TRIGGER invoice_payments_no_delete BEFORE DELETE ON invoice_payments WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id) AND EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'Zahlungen sind unveränderlich'); END;
CREATE TRIGGER invoice_documents_no_update BEFORE UPDATE ON invoice_documents BEGIN SELECT RAISE(ABORT, 'Archivierte Dokumente sind unveränderlich'); END;
CREATE TRIGGER invoice_documents_no_delete BEFORE DELETE ON invoice_documents WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id) AND EXISTS (SELECT 1 FROM invoices WHERE id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'Archivierte Dokumente sind unveränderlich'); END;
`;

const attachment = (name: string, type: string, body: Buffer | string, inline = true): RawResult => ({
  __raw: true,
  status: 200,
  headers: { 'content-type': type, 'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  body,
});

const SETTING_STRINGS = ['street', 'postal_code', 'city', 'country', 'tax_number', 'contact_name', 'contact_phone', 'bank', 'paypal', 'footer', 'tax_id'] as const;

/** Validates and cleans a patch of `settings.invoices` from the settings page. */
export function cleanInvoiceSettings(app: App, loc: string, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const cur = billingSettings(app, loc);
  for (const k of SETTING_STRINGS) if (b[k] !== undefined) out[k] = str(b[k], k, { max: k === 'footer' ? 400 : 150 });
  if (b.vat_id !== undefined) {
    const v = String(b.vat_id ?? '').trim();
    if (v) {
      const c = checkVatId(v);
      if (!c.valid) throw bad(`Deine USt-IdNr.: ${c.reason}`);
      out.vat_id = c.normalized;
    } else out.vat_id = '';
  }
  if (b.contact_email !== undefined) {
    const v = String(b.contact_email ?? '').trim();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw bad('E-Mail des Ansprechpartners: bitte eine gültige Adresse angeben');
    out.contact_email = v;
  }
  if (b.iban !== undefined) {
    const v = normalizeIban(b.iban);
    if (v && !checkIban(v)) throw bad('Die IBAN ist ungültig – bitte prüfen');
    out.iban = v;
  }
  if (b.bic !== undefined) {
    const v = String(b.bic ?? '').replace(/\s+/g, '').toUpperCase();
    if (v && !checkBic(v)) throw bad('Die BIC ist ungültig');
    out.bic = v;
  }
  for (const k of ['tax_rate', 'payment_terms_days'] as const) {
    if (b[k] === undefined) continue;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > (k === 'tax_rate' ? 100 : 365)) throw bad(k === 'tax_rate' ? 'Standard-USt: 0 bis 100 %' : 'Zahlungsziel: 0 bis 365 Tage');
    out[k] = n;
  }
  for (const k of ['small_business', 'vies_check', 'finalise_strict', 'attach_pdf', 'attach_xrechnung', 'attach_zugferd'] as const) if (b[k] !== undefined) out[k] = !!b[k];
  if (b.default_tax_mode !== undefined) {
    if (!isTaxMode(b.default_tax_mode)) throw bad('Unbekannte Steuerbehandlung');
    out.default_tax_mode = b.default_tax_mode;
  }
  if (b.einvoice_syntax !== undefined) {
    if (!['cii', 'ubl'].includes(b.einvoice_syntax)) throw bad('E-Rechnungs-Format: cii oder ubl');
    out.einvoice_syntax = b.einvoice_syntax;
  }
  if (b.ranges && typeof b.ranges === 'object') {
    const ranges: Record<string, any> = {};
    for (const key of RANGE_KEYS) {
      if (!b.ranges[key]) continue;
      try {
        // the next number is set through the counter below, not stored as the start of the range
        const { next: _n, ...rest } = b.ranges[key];
        ranges[key] = cleanRange(rest, rangeCfg(cur, key));
      } catch (e) {
        throw bad(`${RANGE_LABELS[key]}: ${(e as Error).message}`);
      }
    }
    if (Object.keys(ranges).length) out.ranges = ranges;
  }
  return out;
}

/** Moves the counter of a range forward ("next number"): numbers already given out can never be given out again. */
function setNextNumber(app: App, loc: string, key: RangeKey, next: unknown) {
  const n = Number(next);
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) throw bad('Nächste Nummer: eine ganze Zahl');
  const cfg = rangeCfg(billingSettings(app, loc), key);
  const year = ymdInTz(new Date(), tzOf(app, loc)).slice(0, 4);
  const period = rangePeriod(cfg, year);
  const row = app.db.get<{ last: number }>('SELECT last FROM invoice_counters WHERE location_id = ? AND range = ? AND period = ?', loc, key, period);
  if (row && n <= row.last) throw new HttpError(409, `${RANGE_LABELS[key]}: die Nummer ${n} ist schon vergeben – die nächste muss größer als ${row.last} sein (Nummern werden nie zweimal verwendet)`);
  app.db.run(`INSERT INTO invoice_counters (location_id, range, period, last) VALUES (?, ?, ?, ?) ON CONFLICT(location_id, range, period) DO UPDATE SET last = excluded.last`, loc, key, period, n - 1);
}

export const invoicingModule: Module = {
  name: 'invoicing',
  migrations: [
    ['001-gobd', GOBD_SQL],
    // Invoices credited in full by credit notes with nothing paid stayed "sent" for good: closed like a cancelled one (void,
    // cancelled_at; no Stornorechnung – the credit notes stand next to it, see invoice-model.ts creditClosed), with an audit entry.
    [
      '002-credited-closed',
      `
      INSERT INTO invoice_audit (id, location_id, invoice_id, at, actor, action, detail)
      SELECT lower(hex(randomblob(8))), location_id, id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'Update', 'invoice.credited', 'Vollständig gutgeschrieben – beim Update geschlossen'
        FROM invoices WHERE kind = 'invoice' AND status = 'sent' AND finalised_at IS NOT NULL AND paid_cents = 0 AND credited_cents > 0 AND total_cents - deducted_cents - credited_cents <= 0;
      UPDATE invoices SET status = 'void', cancelled_at = COALESCE(cancelled_at, updated_at)
       WHERE kind = 'invoice' AND status = 'sent' AND finalised_at IS NOT NULL AND paid_cents = 0 AND credited_cents > 0 AND total_cents - deducted_cents - credited_cents <= 0;
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;

    // The invoices of the update get their snapshot and SHA-256; invoices flipped to "sent" by raw SQL are adopted.
    try {
      const n = backfillSnapshots(app);
      if (n) console.log(`[invoices] ${n} bestehende Rechnungen festgeschrieben (Momentaufnahme + SHA-256)`);
    } catch (e) {
      console.error('[invoices] backfill', (e as Error).message);
    }
    let last = 0;
    app.onTick(() => {
      if (Date.now() - last < 30_000) return;
      last = Date.now();
      adoptStragglers(app);
      backfillSnapshots(app, 200);
    });
    // A cancelled invoice frees the time entries that were billed on it.
    app.events.on('invoice.cancelled', (e) => {
      const invId = e.data?.invoice?.id;
      if (invId && db.get(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'pm_time_entries'`)) db.run('UPDATE pm_time_entries SET invoice_id = NULL, billed_at = NULL WHERE invoice_id = ? AND location_id = ?', invId, e.locationId);
    });

    // --- the state changes --------------------------------------------------------------------------------------------------------
    router.post('/api/invoices/:id/finalise', 'location', async (ctx) => {
      const inv = mustInvoice(app, ctx.locationId, ctx.params.id);
      if (inv.finalised_at) throw new HttpError(409, `Die Rechnung ${inv.number} ist schon festgeschrieben`);
      const fin = await finaliseChecked(app, ctx.locationId, inv.id, { actor: actorOf(ctx), issued_at: ctx.body?.issued_at, adopt: false });
      return invoiceOut(app, fin.invoice, { warnings: fin.warnings });
    });

    router.get('/api/invoices/:id/precheck', 'location', (ctx) => precheck(app, ctx.locationId, ctx.params.id));

    router.post('/api/invoices/:id/storno', 'location', async (ctx) => {
      const r = stornoInvoice(app, ctx.locationId, ctx.params.id, { reason: str(ctx.body?.reason, 'Grund', { max: 300 }), actor: actorOf(ctx) });
      let send_error: string | undefined;
      let storno = r.storno;
      if (ctx.body?.send) {
        try {
          storno = await sendInvoice(app, ctx.locationId, storno, { actor: actorOf(ctx), userId: ctx.user?.id, channel: ctx.body.channel });
        } catch (e) {
          send_error = (e as Error).message;
        }
      }
      return { storno: invoiceOut(app, storno), original: invoiceOut(app, r.original), ...(send_error ? { send_error } : {}) };
    });

    router.post('/api/invoices/:id/credit-note', 'location', (ctx) => {
      const cn = createCreditNote(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, actorOf(ctx));
      return invoiceOut(app, cn);
    });

    router.post('/api/invoices/:id/convert', 'location', (ctx) => {
      const t = ctx.body?.inv_type;
      return invoiceOut(app, convertEstimate(app, ctx.locationId, ctx.params.id, actorOf(ctx), { inv_type: t === 'partial' || t === 'final' ? t : 'standard' }));
    });

    router.get('/api/invoices/:id/payments', 'location', (ctx) => {
      mustInvoice(app, ctx.locationId, ctx.params.id);
      return db.all('SELECT * FROM invoice_payments WHERE invoice_id = ? AND location_id = ? ORDER BY created_at', ctx.params.id, ctx.locationId);
    });
    router.post('/api/invoices/:id/payments', 'location', (ctx) => {
      const r = recordPayment(app, ctx.locationId, ctx.params.id, ctx.body ?? {}, actorOf(ctx));
      return { ...invoiceOut(app, r.invoice), payment_id: r.payment_id, paid: r.paid };
    });
    router.post('/api/invoices/:id/payments/:pid/revert', 'location', (ctx) => invoiceOut(app, revertPayment(app, ctx.locationId, ctx.params.id, ctx.params.pid, actorOf(ctx), str(ctx.body?.reason, 'Grund', { max: 300 }))));

    // --- files ----------------------------------------------------------------------------------------------------------------------
    router.get('/api/invoices/:id/pdf', 'location', (ctx) => {
      const inv = mustInvoice(app, ctx.locationId, ctx.params.id);
      const out = invoicePdfOf(app, inv);
      return attachment(out.filename, 'application/pdf', out.pdf, ctx.query.get('download') !== '1');
    });
    router.get('/api/invoices/:id/einvoice/check', 'location', (ctx) => einvoiceReport(app, mustInvoice(app, ctx.locationId, ctx.params.id), ctx.query.get('syntax') === 'ubl' ? 'ubl' : 'cii'));
    router.get('/api/invoices/:id/xrechnung', 'location', (ctx) => {
      const inv = mustInvoice(app, ctx.locationId, ctx.params.id);
      const out = einvoiceOf(app, inv, ctx.query.get('syntax') === 'ubl' ? 'ubl' : 'cii');
      const actor = actorOf(ctx);
      const doc = archiveEinvoice(app, inv, out, actor);
      if (!doc.duplicate) invAudit(app, ctx.locationId, inv.id, 'einvoice.generated', `${out.syntax === 'ubl' ? 'UBL 2.1' : 'CII'} · SHA-256 ${doc.sha256.slice(0, 16)}… · Aufbewahrung bis ${doc.retention_until}`, actor);
      // format=json: the XML inside a JSON answer (MCP tools and API clients that only read JSON)
      if (ctx.query.get('format') === 'json') return { filename: out.filename, syntax: out.syntax, xml: out.xml, sha256: doc.sha256, retention_until: doc.retention_until, validation: { valid: out.validation.valid, errors: out.validation.errors, warnings: out.validation.warnings } };
      return attachment(out.filename, 'application/xml; charset=utf-8', out.xml, ctx.query.get('download') !== '1');
    });
    router.get('/api/invoices/:id/documents', 'location', (ctx) => {
      mustInvoice(app, ctx.locationId, ctx.params.id);
      return db.all(
        `SELECT d.id, d.kind, d.sha256, d.size, d.retention_until, d.created_at, a.name FROM invoice_documents d LEFT JOIN acc_documents a ON a.id = d.document_id WHERE d.invoice_id = ? AND d.location_id = ? ORDER BY d.created_at`,
        ctx.params.id,
        ctx.locationId,
      );
    });
    router.get('/api/invoices/:id/documents/:docId/download', 'location', (ctx) => {
      const d = db.get<any>(`SELECT d.*, a.name, a.mime FROM invoice_documents d JOIN acc_documents a ON a.id = d.document_id WHERE d.id = ? AND d.invoice_id = ? AND d.location_id = ?`, ctx.params.docId, ctx.params.id, ctx.locationId);
      if (!d) throw notFound();
      const path = archivedFile(app, { id: d.document_id, mime: d.mime });
      if (!existsSync(path)) throw new HttpError(410, 'Die archivierte Datei fehlt auf dem Server');
      return attachment(d.name, d.mime, readFileSync(path), false);
    });

    // --- trail and integrity ---------------------------------------------------------------------------------------------------------
    router.get('/api/invoices/:id/audit', 'location', (ctx) => {
      mustInvoice(app, ctx.locationId, ctx.params.id);
      return db.all('SELECT id, at, actor, action, detail FROM invoice_audit WHERE invoice_id = ? AND location_id = ? ORDER BY at, rowid', ctx.params.id, ctx.locationId);
    });
    router.get('/api/invoices/:id/verify', 'location', (ctx) => verifyInvoice(app, ctx.locationId, ctx.params.id));

    // --- VAT ID ---------------------------------------------------------------------------------------------------------------------
    router.post('/api/invoices/vat-check', 'location', async (ctx) => {
      const c = checkVatId(ctx.body?.vat_id);
      const cfg = billingSettings(app, ctx.locationId);
      const out: Record<string, any> = { format_ok: c.valid, vat_id: c.normalized, country: c.country, ...(c.valid ? {} : { reason: c.reason }), vies: null, vies_enabled: !!cfg.vies_check };
      if (c.valid && cfg.vies_check) out.vies = await viesCheck(app, c.normalized);
      return out;
    });

    // --- settings: seller data, tax defaults and the number ranges ------------------------------------------------------------------------
    const settingsOut = (loc: string) => ({
      settings: billingSettings(app, loc),
      ranges: Object.fromEntries(RANGE_KEYS.map((k) => [k, { label: RANGE_LABELS[k], ...rangeStatus(app, loc, k) }])),
      tax_modes: Object.entries(TAX_MODES).map(([key, m]) => ({ key, label: m.label, note: m.note, needs_buyer_vat: !!m.needsBuyerVat, needs_seller_vat: !!m.needsSellerVat })),
      units: Object.entries(UNITS).map(([code, label]) => ({ code, label })),
    });
    router.get('/api/invoice-settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/invoice-settings', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const patch = cleanInvoiceSettings(app, ctx.locationId, b);
      db.tx(() => {
        // counters first: a refused "next number" must not save the rest
        if (b.ranges && typeof b.ranges === 'object') for (const key of RANGE_KEYS) if (b.ranges[key]?.next !== undefined && b.ranges[key].next !== '') setNextNumber(app, ctx.locationId, key, b.ranges[key].next);
        if (Object.keys(patch).length) {
          const cur = app.location(ctx.locationId)!;
          db.update('locations', ctx.locationId, { settings: sealSettings(app, mergeSettings(cur.settings, { invoices: patch })).value });
        }
      });
      return settingsOut(ctx.locationId);
    });
  },
};
