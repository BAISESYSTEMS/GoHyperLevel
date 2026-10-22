import type { App, Module } from '../core/app.js';
import { clampLimit, bad, notFound, num, str, type Ctx } from '../core/http.js';
import { id, now } from '../core/util.js';
import { isStandard, DEFAULT_MAPPING, MAPPING_KEYS, MAPPING_LABELS, type AccKind, type AccType } from '../services/acc-chart.js';
import {
  chartMap,
  cleanDate,
  getEntry,
  getSettings,
  listPeriods,
  lockThrough,
  postEntry,
  requireEnabled,
  saveSettings,
  seedChart,
  stornoEntry,
  todayYmd,
  trail,
  verifyChain,
  type AccountRow,
  type EntryRow,
  type PostingIn,
} from '../services/acc-ledger.js';
import { summary, cleanRange } from '../services/acc-reports.js';
import { TAX_CODE_LIST } from '../services/acc-vat.js';
import { sealSecret } from '../core/secrets.js';
import type { Tool } from './mcp.js';

/**
 * Buchhaltung light – "Vorbereitung für Steuerberater". Chart of accounts (SKR03/SKR04), double-entry journal with
 * Storno instead of editing, period lock (Festschreibung), audit trail. NOT certified accounting software, no
 * GoBD certification, no ELSTER. See docs/backoffice.md.
 */

export const DISCLAIMER =
  'Buchhaltung light zur Vorbereitung für den Steuerberater – keine zertifizierte Buchhaltungssoftware, keine GoBD-Zertifizierung, keine Steuerberatung und keine Übermittlung an das Finanzamt (ELSTER). Bitte alle Auswertungen und Exporte mit dem Steuerberater abstimmen.';

const MIGRATION = `
CREATE TABLE acc_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', receipt_key TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE acc_accounts (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, number TEXT NOT NULL, name TEXT NOT NULL,
  type TEXT NOT NULL, kind TEXT NOT NULL DEFAULT '', auto_tax TEXT NOT NULL DEFAULT '', grp TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, custom INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(location_id, number)
);
CREATE TABLE acc_periods (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, period TEXT NOT NULL,
  locked_at TEXT, locked_by TEXT, locked_by_name TEXT NOT NULL DEFAULT '', UNIQUE(location_id, period)
);
CREATE TABLE acc_entries (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, seq INTEGER NOT NULL, number TEXT NOT NULL,
  date TEXT NOT NULL, doc_date TEXT NOT NULL, due_date TEXT, period TEXT NOT NULL, text TEXT NOT NULL, doc_ref TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual', source_id TEXT, source_key TEXT, postings TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
  party_name TEXT NOT NULL DEFAULT '', contact_id TEXT, receipt_id TEXT, document_id TEXT, reverses_id TEXT, reversed_by TEXT,
  prev_hash TEXT NOT NULL DEFAULT '', hash TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL,
  UNIQUE(location_id, seq)
);
CREATE UNIQUE INDEX acc_entries_source_key ON acc_entries(location_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX acc_entries_date ON acc_entries(location_id, date);
CREATE INDEX acc_entries_period ON acc_entries(location_id, period);
CREATE INDEX acc_entries_doc ON acc_entries(location_id, doc_ref);
CREATE INDEX acc_entries_contact ON acc_entries(contact_id);
CREATE TABLE acc_lines (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES acc_entries(id) ON DELETE CASCADE, location_id TEXT NOT NULL, line_no INTEGER NOT NULL,
  account TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('S', 'H')), cents INTEGER NOT NULL CHECK (cents > 0),
  tax_code TEXT NOT NULL DEFAULT '', is_tax INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX acc_lines_entry ON acc_lines(entry_id);
CREATE INDEX acc_lines_account ON acc_lines(location_id, account);
CREATE TABLE acc_audit (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, at TEXT NOT NULL, user_id TEXT,
  actor TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, entry_id TEXT, detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX acc_audit_loc ON acc_audit(location_id, at);
CREATE TABLE acc_documents (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'receipt', created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX acc_documents_loc ON acc_documents(location_id, created_at);
CREATE TABLE acc_receipts (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, document_id TEXT, status TEXT NOT NULL DEFAULT 'inbox',
  source TEXT NOT NULL DEFAULT 'upload', supplier TEXT NOT NULL DEFAULT '', supplier_key TEXT NOT NULL DEFAULT '', supplier_vat_id TEXT NOT NULL DEFAULT '',
  invoice_no TEXT NOT NULL DEFAULT '', invoice_date TEXT, due_date TEXT, currency TEXT NOT NULL DEFAULT 'EUR', net_cents INTEGER, vat_cents INTEGER,
  gross_cents INTEGER, vat_rate REAL, reverse_charge INTEGER NOT NULL DEFAULT 0, credit_note INTEGER NOT NULL DEFAULT 0, lines TEXT NOT NULL DEFAULT '[]',
  account TEXT NOT NULL DEFAULT '', payment TEXT NOT NULL DEFAULT 'open', extraction TEXT NOT NULL DEFAULT '{}', iban TEXT NOT NULL DEFAULT '',
  contact_id TEXT, entry_id TEXT, payment_entry_id TEXT, bank_txn_id TEXT, note TEXT NOT NULL DEFAULT '', from_email TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX acc_receipts_loc ON acc_receipts(location_id, status, created_at);
CREATE INDEX acc_receipts_supplier ON acc_receipts(location_id, supplier_key, status);
CREATE INDEX acc_receipts_contact ON acc_receipts(contact_id);
CREATE TABLE acc_bank_imports (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, name TEXT NOT NULL DEFAULT '', format TEXT NOT NULL,
  txns INTEGER NOT NULL DEFAULT 0, new_txns INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE acc_bank_txns (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, import_id TEXT, booking_date TEXT NOT NULL, value_date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR', counterparty TEXT NOT NULL DEFAULT '', counterparty_iban TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '', end_to_end_id TEXT NOT NULL DEFAULT '', bank_ref TEXT NOT NULL DEFAULT '', account_iban TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', match TEXT NOT NULL DEFAULT '{}', entry_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(location_id, dedupe_key)
);
CREATE INDEX acc_bank_txns_loc ON acc_bank_txns(location_id, status, booking_date);

-- GoBD principles: posted entries are immutable (a mistake is cancelled by a Storno entry), the audit trail is append-only,
-- a locked period (Festschreibung) stays locked. The delete triggers step aside only while a whole sub-account is removed.
CREATE TRIGGER acc_entries_no_update BEFORE UPDATE OF location_id, seq, number, date, doc_date, due_date, period, text, doc_ref, source, source_id, source_key, postings, currency, party_name, reverses_id, prev_hash, hash, created_by, created_at ON acc_entries
BEGIN SELECT RAISE(ABORT, 'Gebuchte Buchungen sind unveränderbar (GoBD) – bitte stornieren'); END;
CREATE TRIGGER acc_entries_reversed_once BEFORE UPDATE OF reversed_by ON acc_entries WHEN OLD.reversed_by IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Diese Buchung wurde schon storniert'); END;
CREATE TRIGGER acc_entries_no_delete BEFORE DELETE ON acc_entries WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Gebuchte Buchungen lassen sich nicht löschen (GoBD) – bitte stornieren'); END;
CREATE TRIGGER acc_lines_no_update BEFORE UPDATE ON acc_lines
BEGIN SELECT RAISE(ABORT, 'Gebuchte Buchungen sind unveränderbar (GoBD) – bitte stornieren'); END;
CREATE TRIGGER acc_lines_no_delete BEFORE DELETE ON acc_lines WHEN EXISTS (SELECT 1 FROM acc_entries WHERE id = OLD.entry_id)
BEGIN SELECT RAISE(ABORT, 'Gebuchte Buchungen lassen sich nicht löschen (GoBD) – bitte stornieren'); END;
CREATE TRIGGER acc_periods_stay_locked BEFORE UPDATE OF locked_at, period ON acc_periods WHEN OLD.locked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Zeiträume lassen sich nicht wieder öffnen'); END;
CREATE TRIGGER acc_periods_no_delete BEFORE DELETE ON acc_periods WHEN OLD.locked_at IS NOT NULL AND EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Festgeschriebene Zeiträume lassen sich nicht wieder öffnen'); END;
CREATE TRIGGER acc_audit_no_update BEFORE UPDATE ON acc_audit
BEGIN SELECT RAISE(ABORT, 'Das Änderungsprotokoll der Buchhaltung ist unveränderbar'); END;
CREATE TRIGGER acc_audit_no_delete BEFORE DELETE ON acc_audit WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Das Änderungsprotokoll der Buchhaltung ist unveränderbar'); END;
CREATE TRIGGER acc_documents_no_update BEFORE UPDATE OF location_id, name, mime, size, sha256, source, created_at ON acc_documents
BEGIN SELECT RAISE(ABORT, 'Archivierte Belege sind unveränderbar (GoBD)'); END;
CREATE TRIGGER acc_documents_no_delete BEFORE DELETE ON acc_documents WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Archivierte Belege lassen sich nicht löschen (GoBD)'); END;
`;

/** Who acts, for the accounting trail and the entries' created_by. */
export function actor(ctx: Ctx): { id: string | null; name: string } {
  if (ctx.user && ctx.via !== 'agency_key' && ctx.via !== 'mcp') return { id: ctx.user.id, name: ctx.user.name || ctx.user.email };
  if (ctx.via === 'mcp' || ctx.via === 'agency_key') return { id: null, name: 'MCP/Agentur-Schlüssel' };
  return { id: null, name: ctx.viaApiKey ? 'API-Schlüssel' : 'System' };
}

const TOOLS: Tool[] = [
  {
    name: 'ghl_booking_summary',
    title: 'Buchungsübersicht für einen Zeitraum',
    description:
      'Zusammenfassung der Buchhaltung (Buchhaltung light, Vorbereitung für den Steuerberater) für einen Zeitraum: Anzahl Buchungen, Erlöse, Aufwand, Ergebnis, größte Kostenarten, offene Forderungen und Verbindlichkeiten. from/to als JJJJ-MM-TT (Standard: laufendes Jahr). Keine Steuerberatung.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/accounting/summary?${new URLSearchParams({ ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_euer_report',
    title: 'EÜR (Einnahmen-Überschuss-Rechnung)',
    description:
      'Einnahmen-Überschuss-Rechnung für ein Jahr oder einen Zeitraum nach Zufluss/Abfluss (Betriebseinnahmen und -ausgaben nach Gruppen, Umsatzsteuer, Gewinn). year (z. B. 2025) oder from/to. Übersicht zur Vorbereitung für den Steuerberater, keine Steuererklärung.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, year: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/accounting/reports/euer?${new URLSearchParams({ ...(a.year ? { year: String(a.year) } : {}), ...(a.from ? { from: a.from } : {}), ...(a.to ? { to: a.to } : {}) })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_vat_overview',
    title: 'USt-Voranmeldung (Übersicht)',
    description: 'Kennzahlen der Umsatzsteuer-Voranmeldung (81, 86, 66 …, Zahllast) für einen Monat (JJJJ-MM), ein Quartal (JJJJ-Q1) oder ein Jahr. Nur Vorbereitung – keine Übermittlung an ELSTER.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, period: { type: 'string', description: 'JJJJ-MM, JJJJ-Q1 … JJJJ-Q4 oder JJJJ' } }, required: ['period'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/accounting/reports/ustva?period=${encodeURIComponent(a.period)}`, { location: a.location_id }),
  },
  {
    name: 'ghl_open_items',
    title: 'Offene Posten',
    description: 'Offene Posten: Forderungen (receivable) oder Verbindlichkeiten (payable) mit Belegnummer, Betrag und Überfälligkeit.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, type: { type: 'string', enum: ['receivable', 'payable'] }, asof: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/accounting/reports/open-items?${new URLSearchParams({ type: a.type ?? 'receivable', ...(a.asof ? { asof: a.asof } : {}) })}`, { location: a.location_id }),
  },
];

export function setReceiptKey(app: App, locationId: string, key: string) {
  app.db.run(
    `INSERT INTO acc_settings (location_id, data, receipt_key, updated_at) VALUES (?, '{}', ?, ?) ON CONFLICT(location_id) DO UPDATE SET receipt_key = excluded.receipt_key`,
    locationId,
    sealSecret(app, key),
    now(),
  );
}

const ACCOUNT_RE = /^\d{4,8}$/;
const TYPES: AccType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
const KINDS: AccKind[] = ['', 'bank', 'cash', 'transit', 'receivable', 'payable', 'vat_in', 'vat_out', 'vat_pay', 'private', 'opening'];

export const accountingModule: Module = {
  name: 'accounting',
  migrations: [['001-init', MIGRATION]],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    // Background work of the accounting (receipt reading, Stripe fees): tests and shutdown can wait for it.
    const pending = new Set<Promise<void>>();
    app.services.accountingPending = pending;
    app.services.accountingFlush = async () => {
      while (pending.size) await Promise.all([...pending]);
    };

    // --- the services other modules use -----------------------------------------------------------------
    app.services.accounting = {
      settings: (loc: string) => getSettings(app, loc),
      enabled: (loc: string) => getSettings(app, loc).enabled,
      post: (loc: string, input: Parameters<typeof postEntry>[2]) => postEntry(app, loc, input),
      storno: (loc: string, entryId: string, opts?: Parameters<typeof stornoEntry>[3]) => stornoEntry(app, loc, entryId, opts),
    };

    // Retention beats erasure: entries, receipts and purchase orders stay, they only lose the link to the contact.
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        for (const t of ['acc_entries', 'acc_receipts']) db.run(`UPDATE ${t} SET contact_id = NULL WHERE location_id = ? AND contact_id = ?`, loc, contact.id);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string }) => {
        const entries = db.all('SELECT number, date, text, doc_ref, party_name FROM acc_entries WHERE location_id = ? AND contact_id = ?', loc, contact.id);
        const receipts = db.all('SELECT supplier, invoice_no, invoice_date, gross_cents, status FROM acc_receipts WHERE location_id = ? AND contact_id = ?', loc, contact.id);
        return { ...(entries.length ? { 'Buchhaltung: Buchungen': entries } : {}), ...(receipts.length ? { 'Buchhaltung: Belege': receipts } : {}) };
      },
    ];

    // --- status, setup, settings --------------------------------------------------------------------------
    const counts = (loc: string) => ({
      receipts_inbox: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM acc_receipts WHERE location_id = ? AND status IN ('inbox', 'review')`, loc)?.n ?? 0,
      bank_open: db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM acc_bank_txns WHERE location_id = ? AND status IN ('open', 'matched')`, loc)?.n ?? 0,
      entries: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM acc_entries WHERE location_id = ?', loc)?.n ?? 0,
    });

    router.get('/api/accounting/status', 'location', (ctx) => {
      const s = getSettings(app, ctx.locationId);
      const lastLocked = db.get<{ p: string | null }>('SELECT MAX(period) AS p FROM acc_periods WHERE location_id = ? AND locked_at IS NOT NULL', ctx.locationId)?.p ?? null;
      return {
        enabled: s.enabled,
        standard: s.standard,
        vat_mode: s.vat_mode,
        vat_method: s.vat_method,
        disclaimer: DISCLAIMER,
        locked_through: lastLocked,
        today: todayYmd(app, ctx.locationId),
        counts: counts(ctx.locationId),
        datev_ready: !!(s.datev.berater && s.datev.mandant),
        invoice_small_business: !!app.location(ctx.locationId)?.settings.invoices?.small_business,
      };
    });

    router.post('/api/accounting/setup', 'location', (ctx) => {
      const cur = getSettings(app, ctx.locationId);
      const standard = ctx.body?.standard;
      if (!isStandard(standard)) throw bad('Kontenrahmen: skr03 oder skr04');
      const entries = counts(ctx.locationId).entries;
      if (cur.enabled && cur.standard !== standard && entries) throw bad('Der Kontenrahmen lässt sich nach der ersten Buchung nicht mehr wechseln');
      const small = ctx.body?.vat_mode === 'small' || (ctx.body?.vat_mode === undefined && !!app.location(ctx.locationId)?.settings.invoices?.small_business);
      db.tx(() => {
        // A different chart before any booking: the standard accounts of the old one go, own accounts stay.
        if (cur.enabled && cur.standard !== standard) db.run('DELETE FROM acc_accounts WHERE location_id = ? AND custom = 0', ctx.locationId);
        seedChart(app, ctx.locationId, standard);
        const next = { ...cur, enabled: true, standard, vat_mode: small ? ('small' as const) : ('regular' as const), mapping: cur.enabled && cur.standard === standard ? cur.mapping : { ...DEFAULT_MAPPING[standard] } };
        saveSettings(app, ctx.locationId, next);
        trail(app, ctx.locationId, actor(ctx), 'setup', null, `${standard}${small ? ', Kleinunternehmer' : ''}`);
      });
      return { ok: true, standard, accounts: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM acc_accounts WHERE location_id = ?', ctx.locationId)?.n };
    });

    const settingsOut = (loc: string) => {
      const s = getSettings(app, loc);
      const key = db.get<{ receipt_key: string | null }>('SELECT receipt_key FROM acc_settings WHERE location_id = ?', loc)?.receipt_key;
      return {
        ...s,
        tax_codes: TAX_CODE_LIST,
        mapping_labels: MAPPING_LABELS,
        receipt_inbound_set: !!key,
        disclaimer: DISCLAIMER,
      };
    };
    router.get('/api/accounting/settings', 'location', (ctx) => settingsOut(ctx.locationId));
    router.put('/api/accounting/settings', 'location', (ctx) => {
      const cur = requireEnabled(app, ctx.locationId);
      const b = ctx.body ?? {};
      const next = { ...cur, autopost: { ...cur.autopost }, datev: { ...cur.datev }, receipts: { ...cur.receipts }, mapping: { ...cur.mapping } };
      if (b.vat_mode !== undefined) {
        if (!['regular', 'small'].includes(b.vat_mode)) throw bad('Umsatzsteuer: regular oder small (Kleinunternehmer)');
        next.vat_mode = b.vat_mode;
      }
      if (b.vat_method !== undefined) {
        if (!['soll', 'ist'].includes(b.vat_method)) throw bad('Versteuerung: soll oder ist');
        next.vat_method = b.vat_method;
      }
      if (b.fy_start_month !== undefined) {
        const m = Math.round(num(b.fy_start_month, 1));
        if (m < 1 || m > 12) throw bad('Wirtschaftsjahr: Beginn im Monat 1–12');
        next.fy_start_month = m;
      }
      for (const k of ['invoices', 'payments', 'stripe', 'skip_linked'] as const) if (b.autopost?.[k] !== undefined) next.autopost[k] = !!b.autopost[k];
      if (b.datev) {
        for (const k of ['berater', 'mandant'] as const) {
          if (b.datev[k] === undefined) continue;
          const v = str(b.datev[k], k, { max: 8 });
          if (v && !/^\d{1,8}$/.test(v)) throw bad(k === 'berater' ? 'Beraternummer: nur Ziffern (4–7 Stellen)' : 'Mandantennummer: nur Ziffern');
          next.datev[k] = v;
        }
        if (b.datev.account_length !== undefined) {
          const n = Math.round(num(b.datev.account_length, 4));
          if (n < 4 || n > 8) throw bad('Sachkontenlänge: 4 bis 8');
          next.datev.account_length = n;
        }
        if (b.datev.name !== undefined) next.datev.name = str(b.datev.name, 'Bezeichnung', { max: 30 });
      }
      if (b.receipts) {
        if (b.receipts.auto_extract !== undefined) next.receipts.auto_extract = !!b.receipts.auto_extract;
        if (b.receipts.allowed_senders !== undefined) {
          if (!Array.isArray(b.receipts.allowed_senders)) throw bad('Absender als Liste');
          next.receipts.allowed_senders = b.receipts.allowed_senders.map((s: unknown) => String(s).trim().toLowerCase()).filter((s: string) => /^[^\s@]+@[^\s@]+$|^@[^\s@]+$/.test(s)).slice(0, 50);
        }
      }
      if (b.mapping) {
        const chart = chartMap(app, ctx.locationId);
        for (const k of MAPPING_KEYS) {
          if (b.mapping[k] === undefined) continue;
          const n = String(b.mapping[k]).trim();
          if (!chart.get(n)?.active) throw bad(`${MAPPING_LABELS[k]}: Konto ${n || '(leer)'} gibt es nicht oder es ist deaktiviert`);
          next.mapping[k] = n;
        }
      }
      saveSettings(app, ctx.locationId, next);
      trail(app, ctx.locationId, actor(ctx), 'settings', null, Object.keys(b).join(', ').slice(0, 200));
      return settingsOut(ctx.locationId);
    });

    // --- chart of accounts --------------------------------------------------------------------------------------
    router.get('/api/accounting/accounts', 'location', (ctx) => {
      const q = (ctx.query.get('q') ?? '').trim();
      const type = ctx.query.get('type');
      const where = ['a.location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (q) (where.push('(a.number LIKE ? OR a.name LIKE ?)'), params.push(`${q}%`, `%${q}%`));
      if (type && TYPES.includes(type as AccType)) (where.push('a.type = ?'), params.push(type));
      if (ctx.query.get('active') === '1') where.push('a.active = 1');
      return db.all(
        `SELECT a.*, (SELECT COUNT(*) FROM acc_lines l WHERE l.location_id = a.location_id AND l.account = a.number) AS lines
         FROM acc_accounts a WHERE ${where.join(' AND ')} ORDER BY a.number LIMIT 1000`,
        ...params,
      );
    });
    router.post('/api/accounting/accounts', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const number = str(ctx.body?.number, 'Kontonummer', { required: true, max: 8 });
      if (!ACCOUNT_RE.test(number)) throw bad('Kontonummer: 4 bis 8 Ziffern');
      const type = ctx.body?.type;
      if (!TYPES.includes(type)) throw bad('Kontoart: asset, liability, equity, income oder expense');
      if (db.get('SELECT 1 FROM acc_accounts WHERE location_id = ? AND number = ?', ctx.locationId, number)) throw bad('Diese Kontonummer gibt es schon');
      const row = {
        id: id(),
        location_id: ctx.locationId,
        number,
        name: str(ctx.body?.name, 'Name', { required: true, max: 120 }),
        type,
        kind: KINDS.includes(ctx.body?.kind) ? ctx.body.kind : '',
        auto_tax: '',
        grp: str(ctx.body?.grp, 'Gruppe', { max: 30 }),
        active: 1,
        custom: 1,
        created_at: now(),
      };
      db.insert('acc_accounts', row);
      trail(app, ctx.locationId, actor(ctx), 'account.create', null, `${number} ${row.name}`);
      return row;
    });
    router.patch('/api/accounting/accounts/:id', 'location', (ctx) => {
      const a = db.get<AccountRow>('SELECT * FROM acc_accounts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      const patch: Record<string, any> = {};
      if (ctx.body?.name !== undefined) patch.name = str(ctx.body.name, 'Name', { required: true, max: 120 });
      if (ctx.body?.active !== undefined) {
        const used = Object.values(getSettings(app, ctx.locationId).mapping).includes(a.number);
        if (!ctx.body.active && used) throw bad('Dieses Konto ist in den Einstellungen zugeordnet – bitte dort zuerst ein anderes wählen');
        patch.active = ctx.body.active ? 1 : 0;
      }
      if (ctx.body?.grp !== undefined) patch.grp = str(ctx.body.grp, 'Gruppe', { max: 30 });
      db.update('acc_accounts', a.id, patch, ctx.locationId);
      trail(app, ctx.locationId, actor(ctx), 'account.update', null, `${a.number}: ${Object.keys(patch).join(', ')}`);
      return db.get('SELECT * FROM acc_accounts WHERE id = ?', a.id);
    });
    router.get('/api/accounting/tax-codes', 'location', () => TAX_CODE_LIST);

    // --- journal -----------------------------------------------------------------------------------------------------
    const withLines = (rows: any[], loc: string): any[] => {
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const lines = db.all<any>(`SELECT entry_id, account, side, cents, tax_code, is_tax, text FROM acc_lines WHERE location_id = ? AND entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY entry_id, line_no`, loc, ...ids);
      const by = new Map<string, any[]>();
      for (const l of lines) by.set(l.entry_id, [...(by.get(l.entry_id) ?? []), l]);
      return rows.map((r) => {
        let postings: unknown = [];
        try {
          postings = JSON.parse(r.postings);
        } catch {
          /* keep empty */
        }
        return { ...r, postings, lines: (by.get(r.id) ?? []).map(({ entry_id: _e, ...l }) => l) };
      });
    };
    router.get('/api/accounting/entries', 'location', (ctx) => {
      const where = ['e.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const from = ctx.query.get('from');
      const to = ctx.query.get('to');
      if (from) (where.push('e.date >= ?'), params.push(cleanDate(from, 'Von')));
      if (to) (where.push('e.date <= ?'), params.push(cleanDate(to, 'Bis')));
      const q = (ctx.query.get('q') ?? '').trim();
      if (q) (where.push(`(e.text LIKE ? OR e.doc_ref LIKE ? OR e.number LIKE ? OR e.party_name LIKE ?)`), params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`));
      const source = ctx.query.get('source');
      if (source) (where.push('e.source = ?'), params.push(source));
      const account = ctx.query.get('account');
      if (account) (where.push('EXISTS (SELECT 1 FROM acc_lines l WHERE l.entry_id = e.id AND l.account = ?)'), params.push(account));
      const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM acc_entries e WHERE ${where.join(' AND ')}`, ...params)?.n ?? 0;
      const limit = clampLimit(ctx.query.get('limit'), 100, 500);
      const offset = Math.max(0, Math.floor(num(ctx.query.get('offset'), 0)));
      const rows = db.all(`SELECT e.* FROM acc_entries e WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
      return { total, entries: withLines(rows, ctx.locationId) };
    });
    router.get('/api/accounting/entries/:id', 'location', (ctx) => {
      const e = getEntry(app, ctx.locationId, ctx.params.id);
      if (!e) throw notFound('Buchung nicht gefunden');
      const original = e.reverses_id ? getEntry(app, ctx.locationId, e.reverses_id) : undefined;
      const reversal = e.reversed_by ? getEntry(app, ctx.locationId, e.reversed_by) : undefined;
      return { ...e, original: original && { id: original.id, number: original.number }, reversal: reversal && { id: reversal.id, number: reversal.number } };
    });
    router.post('/api/accounting/entries', 'location', (ctx) => {
      const b = ctx.body ?? {};
      if (!Array.isArray(b.postings)) throw bad('postings fehlt');
      const postings: PostingIn[] = b.postings.slice(0, 200).map((p: any) => ({
        debit: String(p?.debit ?? ''),
        credit: String(p?.credit ?? ''),
        amount_cents: Number(p?.amount_cents),
        tax_code: p?.tax_code || 'none',
        text: String(p?.text ?? ''),
      }));
      const a = actor(ctx);
      const { entry } = postEntry(app, ctx.locationId, {
        date: b.date ? cleanDate(b.date, 'Buchungsdatum') : todayYmd(app, ctx.locationId),
        doc_date: b.doc_date,
        due_date: b.due_date || null,
        text: str(b.text, 'Buchungstext', { required: true, max: 200 }),
        doc_ref: str(b.doc_ref, 'Belegnummer', { max: 60 }),
        source: b.opening ? 'opening' : 'manual',
        postings,
        party_name: str(b.party_name, 'Name', { max: 200 }),
        contact_id: b.contact_id ? String(b.contact_id) : null,
        user_id: a.id,
        actor: a.name,
      });
      return entry;
    });
    router.post('/api/accounting/entries/:id/storno', 'location', (ctx) => {
      const a = actor(ctx);
      return stornoEntry(app, ctx.locationId, ctx.params.id, { date: ctx.body?.date, reason: ctx.body?.reason, user: a });
    });

    // --- periods, trail, integrity ----------------------------------------------------------------------------------
    router.get('/api/accounting/periods', 'location', (ctx) => {
      // Default: this year in the sub-account's time zone, not in UTC (00:30 on 1 January in Berlin is the new year).
      const y = Math.round(num(ctx.query.get('year'), Number(todayYmd(app, ctx.locationId).slice(0, 4))));
      if (y < 2000 || y > 2100) throw bad('Jahr ungültig');
      return { year: y, periods: listPeriods(app, ctx.locationId, y) };
    });
    router.post('/api/accounting/periods/lock', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const a = actor(ctx);
      const locked = lockThrough(app, ctx.locationId, String(ctx.body?.through ?? ''), a);
      return { ok: true, locked };
    });
    router.get('/api/accounting/audit', 'location', (ctx) => db.all('SELECT * FROM acc_audit WHERE location_id = ? ORDER BY at DESC, rowid DESC LIMIT ?', ctx.locationId, clampLimit(ctx.query.get('limit'), 100, 500)));
    router.get('/api/accounting/verify', 'location', (ctx) => {
      const chain = verifyChain(app, ctx.locationId);
      const docs = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM acc_documents WHERE location_id = ?', ctx.locationId)?.n ?? 0;
      return { ...chain, documents: docs };
    });

    router.get('/api/accounting/summary', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = cleanRange(ctx.query.get('from'), ctx.query.get('to'), Number(todayYmd(app, ctx.locationId).slice(0, 4)));
      return summary(app, ctx.locationId, r.from, r.to);
    });
  },
};

export type { EntryRow };
