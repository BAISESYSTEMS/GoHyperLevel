import type { App } from '../core/app.js';
import { HttpError, bad, notFound } from '../core/http.js';
import { ymdInTz } from '../core/time.js';
import { id, now, sha256 } from '../core/util.js';
import { CHARTS, DEFAULT_MAPPING, MAPPING_KEYS, isStandard, type AccKind, type AccType, type Mapping, type Standard } from './acc-chart.js';
import { TAX_CODES, cleanTaxCode, splitAmount, type TaxCode } from './acc-vat.js';

/**
 * The double-entry journal of the light accounting ("Buchhaltung light, Vorbereitung für Steuerberater").
 *
 * Not certified accounting software and no GoBD certification. The GoBD principles are followed where
 * practical: posted entries are immutable (database triggers refuse UPDATE/DELETE; a mistake is cancelled by a
 * Storno entry), every entry is chained to the previous one by a SHA-256 hash, an audit trail records every
 * action and is never pruned, and whole months can be locked (Festschreibung) for good.
 */

export interface AccSettings {
  enabled: boolean;
  standard: Standard;
  mapping: Mapping;
  vat_mode: 'regular' | 'small';
  /** Soll = Umsatzsteuer by invoice date, ist = by payment (Ist-Versteuerung). */
  vat_method: 'soll' | 'ist';
  fy_start_month: number;
  autopost: { invoices: boolean; payments: boolean; stripe: boolean; skip_linked: boolean };
  datev: { berater: string; mandant: string; account_length: number; name: string };
  receipts: { auto_extract: boolean; allowed_senders: string[] };
}

export const defaultSettings = (standard: Standard = 'skr03'): AccSettings => ({
  enabled: false,
  standard,
  mapping: { ...DEFAULT_MAPPING[standard] },
  vat_mode: 'regular',
  vat_method: 'soll',
  fy_start_month: 1,
  autopost: { invoices: true, payments: true, stripe: true, skip_linked: false },
  datev: { berater: '', mandant: '', account_length: 4, name: '' },
  receipts: { auto_extract: true, allowed_senders: [] },
});

export function getSettings(app: App, locationId: string): AccSettings {
  const row = app.db.get<{ data: string }>('SELECT data FROM acc_settings WHERE location_id = ?', locationId);
  let saved: any = {};
  try {
    saved = row ? JSON.parse(row.data) : {};
  } catch {
    saved = {};
  }
  const standard: Standard = isStandard(saved.standard) ? saved.standard : 'skr03';
  const base = defaultSettings(standard);
  return {
    ...base,
    ...saved,
    standard,
    mapping: { ...base.mapping, ...(saved.mapping ?? {}) },
    autopost: { ...base.autopost, ...(saved.autopost ?? {}) },
    datev: { ...base.datev, ...(saved.datev ?? {}) },
    receipts: { ...base.receipts, ...(saved.receipts ?? {}) },
  };
}

export function saveSettings(app: App, locationId: string, s: AccSettings) {
  app.db.run(
    `INSERT INTO acc_settings (location_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(location_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    locationId,
    JSON.stringify(s),
    now(),
  );
}

export interface AccountRow {
  id: string;
  location_id: string;
  number: string;
  name: string;
  type: AccType;
  kind: AccKind;
  auto_tax: TaxCode | '';
  grp: string;
  active: number;
  custom: number;
}

/** Seeds the chart of accounts of `standard` (idempotent: existing numbers are kept). */
export function seedChart(app: App, locationId: string, standard: Standard): number {
  let n = 0;
  for (const a of CHARTS[standard]) {
    const r = app.db.run(
      `INSERT OR IGNORE INTO acc_accounts (id, location_id, number, name, type, kind, auto_tax, grp, active, custom, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
      id(),
      locationId,
      a.n,
      a.name,
      a.type,
      a.kind ?? '',
      a.auto ?? '',
      a.grp ?? '',
      now(),
    );
    n += r.changes;
  }
  return n;
}

export const chartMap = (app: App, locationId: string): Map<string, AccountRow> => new Map(app.db.all<AccountRow>('SELECT * FROM acc_accounts WHERE location_id = ?', locationId).map((a) => [a.number, a]));

// --- types of the journal ---------------------------------------------------

export interface PostingIn {
  debit: string;
  credit: string;
  /** Gross amount in cents (for reverse charge: the net, which is what is paid). */
  amount_cents: number;
  tax_code?: TaxCode | string;
  /** Known net/tax (an invoice's own rounding) instead of computing them from the gross. */
  net_cents?: number;
  tax_cents?: number;
  text?: string;
}

export interface Posting {
  debit: string;
  credit: string;
  amount_cents: number;
  tax_code: TaxCode;
  net_cents: number;
  tax_cents: number;
  /** Which account carries the tax code (the revenue/expense account): 'debit' or 'credit'. */
  taxed_side: 'debit' | 'credit';
  text: string;
}

export interface Line {
  account: string;
  side: 'S' | 'H';
  cents: number;
  tax_code: string;
  /** 0 = ordinary line, 1 = output VAT (Umsatzsteuer), 2 = input VAT (Vorsteuer). */
  is_tax: number;
  text: string;
}

export interface EntryInput {
  date: string;
  doc_date?: string;
  due_date?: string | null;
  text: string;
  doc_ref?: string;
  source?: string;
  source_id?: string | null;
  source_key?: string | null;
  postings: PostingIn[];
  party_name?: string;
  contact_id?: string | null;
  receipt_id?: string | null;
  document_id?: string | null;
  user_id?: string | null;
  reverses_id?: string | null;
  /** Shown in the audit trail (name of the person or "System"). */
  actor?: string;
}

export interface EntryRow {
  id: string;
  location_id: string;
  seq: number;
  number: string;
  date: string;
  doc_date: string;
  due_date: string | null;
  period: string;
  text: string;
  doc_ref: string;
  source: string;
  source_id: string | null;
  source_key: string | null;
  postings: Posting[];
  currency: string;
  party_name: string;
  contact_id: string | null;
  receipt_id: string | null;
  document_id: string | null;
  reverses_id: string | null;
  reversed_by: string | null;
  prev_hash: string;
  hash: string;
  created_by: string | null;
  created_at: string;
  lines: Line[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function cleanDate(v: unknown, field = 'Datum'): string {
  const s = String(v ?? '').trim();
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`)) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw bad(`${field}: bitte als JJJJ-MM-TT angeben`);
  return s;
}
export const periodOf = (date: string) => date.slice(0, 7);
/**
 * Today's date in the sub-account's time zone (what the bookkeeper's calendar shows). The UTC date is yesterday between 00:00 and 02:00 in
 * Berlin: a booking made at 00:30 on the 1st landed in the previous month – possibly one that is already locked.
 */
export function todayYmd(app?: App, locationId?: string): string {
  const tz = app && locationId ? app.location(locationId)?.timezone : undefined;
  try {
    return ymdInTz(new Date(), tz || 'UTC');
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// --- postings → lines ------------------------------------------------------------

function taxAccounts(code: TaxCode, m: Mapping): { out?: string; in?: string } {
  switch (code) {
    case 'ust19':
      return { out: m.vat_out19 };
    case 'ust7':
      return { out: m.vat_out7 };
    case 'vst19':
      return { in: m.vat_in19 };
    case 'vst7':
      return { in: m.vat_in7 };
    case 'rc19':
      return { in: m.vat_rc_in, out: m.vat_rc_out };
    default:
      return {};
  }
}

/** Validates a posting against the chart and the tax code and works out net, tax and the taxed side. */
export function normalizePosting(p: PostingIn, chart: Map<string, AccountRow>, mapping: Mapping): Posting {
  const debit = String(p.debit ?? '').trim();
  const credit = String(p.credit ?? '').trim();
  const dAcc = chart.get(debit);
  const cAcc = chart.get(credit);
  if (!dAcc) throw bad(`Soll-Konto „${debit}“ gibt es nicht im Kontenrahmen`);
  if (!cAcc) throw bad(`Haben-Konto „${credit}“ gibt es nicht im Kontenrahmen`);
  if (!dAcc.active) throw bad(`Konto ${debit} ist deaktiviert`);
  if (!cAcc.active) throw bad(`Konto ${credit} ist deaktiviert`);
  if (debit === credit) throw bad('Soll- und Haben-Konto müssen verschieden sein');
  const amount = Number(p.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) throw bad('Der Betrag muss größer als 0 sein (in Cent, ganze Zahl)');
  if (amount > 99_999_999_999) throw bad('Betrag zu groß');
  let code: TaxCode;
  try {
    code = cleanTaxCode(p.tax_code, 'none');
  } catch (e) {
    throw bad((e as Error).message);
  }
  const def = TAX_CODES[code];
  const known = p.net_cents !== undefined && p.tax_cents !== undefined ? { net: Math.round(Number(p.net_cents)), tax: Math.round(Number(p.tax_cents)) } : {};
  if ((known as any).net !== undefined && (!Number.isInteger((known as any).net) || !Number.isInteger((known as any).tax) || (known as any).net < 0 || (known as any).tax < 0)) throw bad('Netto/Steuer ungültig');
  const split = splitAmount(code, amount, known);
  if (known && (known as any).net !== undefined && def.kind !== 'rc_in' && split.gross !== amount) throw bad('Netto + Steuer ergeben nicht den Betrag');
  // The account that carries the tax: revenue for output codes, expense/asset for input codes.
  // Expense beats (plain) asset; bank, receivables and tax accounts never carry a tax code.
  const spend = (a: AccountRow) => (a.type === 'expense' ? 2 : a.type === 'asset' && !a.kind ? 1 : 0);
  let taxed: 'debit' | 'credit';
  if (def.kind === 'output') taxed = dAcc.type === 'income' && cAcc.type !== 'income' ? 'debit' : 'credit';
  else if (def.kind === 'input' || def.kind === 'rc_in') taxed = spend(cAcc) > spend(dAcc) ? 'credit' : 'debit';
  else taxed = dAcc.type === 'income' || dAcc.type === 'expense' ? 'debit' : cAcc.type === 'income' || cAcc.type === 'expense' ? 'credit' : 'debit';
  const taxedAcc = taxed === 'debit' ? dAcc : cAcc;
  // DATEV "Automatikkonto": the account books its tax by itself, so the tax code has to be the one it expects.
  if (taxedAcc.auto_tax && taxedAcc.auto_tax !== code) throw bad(`Konto ${taxedAcc.number} (${taxedAcc.name}) bucht automatisch „${TAX_CODES[taxedAcc.auto_tax as TaxCode].label}“ – bitte diesen Steuerschlüssel wählen oder ein anderes Konto`);
  // Revenue carries output codes, expenses and plain assets input codes (and reverse charge).
  if (def.kind === 'output' && taxedAcc.type !== 'income') throw bad(`Der Steuerschlüssel „${def.label}“ gehört auf ein Erlöskonto, nicht auf ${taxedAcc.number}`);
  if ((def.kind === 'input' || def.kind === 'rc_in') && spend(taxedAcc) === 0) throw bad(`Vorsteuer gehört auf ein Aufwands- oder Anlagekonto, nicht auf ${taxedAcc.number}`);
  const tax = def.rate ? split.tax : 0;
  const accts = taxAccounts(code, mapping);
  for (const a of [accts.in, accts.out]) if (tax && a && !chart.get(a)) throw bad(`Steuerkonto ${a} fehlt im Kontenrahmen (Einstellungen → Konten zuordnen)`);
  return { debit, credit, amount_cents: amount, tax_code: code, net_cents: split.net, tax_cents: tax, taxed_side: taxed, text: String(p.text ?? '').slice(0, 300) };
}

/** The double-entry lines of a posting (net on the taxed account, VAT on the tax account, gross on the other side). */
export function expandPosting(p: Posting, mapping: Mapping): Line[] {
  const def = TAX_CODES[p.tax_code];
  const lines: Line[] = [];
  const text = p.text;
  const code = p.tax_code === 'none' ? '' : p.tax_code;
  const taxedAcc = p.taxed_side === 'debit' ? p.debit : p.credit;
  const counterAcc = p.taxed_side === 'debit' ? p.credit : p.debit;
  const taxedSide: 'S' | 'H' = p.taxed_side === 'debit' ? 'S' : 'H';
  const counterSide: 'S' | 'H' = taxedSide === 'S' ? 'H' : 'S';
  if (def.kind === 'rc_in') {
    const a = taxAccounts(p.tax_code, mapping);
    lines.push({ account: taxedAcc, side: taxedSide, cents: p.net_cents, tax_code: code, is_tax: 0, text });
    lines.push({ account: counterAcc, side: counterSide, cents: p.net_cents, tax_code: '', is_tax: 0, text });
    if (p.tax_cents) {
      // Input tax and output tax of § 13b UStG cancel out: the recipient owes and deducts the same amount.
      lines.push({ account: a.in!, side: taxedSide, cents: p.tax_cents, tax_code: code, is_tax: 2, text: `${text ? `${text} – ` : ''}Vorsteuer § 13b` });
      lines.push({ account: a.out!, side: counterSide, cents: p.tax_cents, tax_code: code, is_tax: 1, text: `${text ? `${text} – ` : ''}Umsatzsteuer § 13b` });
    }
    return lines;
  }
  lines.push({ account: taxedAcc, side: taxedSide, cents: p.net_cents, tax_code: code, is_tax: 0, text });
  if (p.tax_cents) {
    const a = taxAccounts(p.tax_code, mapping);
    const acct = def.kind === 'output' ? a.out! : a.in!;
    lines.push({ account: acct, side: taxedSide, cents: p.tax_cents, tax_code: code, is_tax: def.kind === 'output' ? 1 : 2, text });
  }
  lines.push({ account: counterAcc, side: counterSide, cents: p.net_cents + p.tax_cents, tax_code: '', is_tax: 0, text });
  return lines;
}

/** Sum of debits and credits. Balanced = equal, and not empty. */
export function balance(lines: Pick<Line, 'side' | 'cents'>[]): { debit: number; credit: number; balanced: boolean } {
  let debit = 0;
  let credit = 0;
  for (const l of lines) (l.side === 'S' ? (debit += l.cents) : (credit += l.cents));
  return { debit, credit, balanced: lines.length >= 2 && debit === credit && debit > 0 };
}

const canonical = (e: { seq: number; number: string; date: string; doc_date: string; text: string; doc_ref: string; source_key: string | null; postings: unknown; lines: Pick<Line, 'account' | 'side' | 'cents' | 'tax_code' | 'is_tax'>[] }) =>
  JSON.stringify([e.seq, e.number, e.date, e.doc_date, e.text, e.doc_ref, e.source_key, e.postings, e.lines.map((l) => [l.account, l.side, l.cents, l.tax_code, l.is_tax])]);
export const entryHash = (prev: string, e: Parameters<typeof canonical>[0]) => sha256(`${prev}|${canonical(e)}`);

// --- periods (Festschreibung) -------------------------------------------------------

export function lockedPeriod(app: App, locationId: string, date: string): boolean {
  return !!app.db.get('SELECT 1 FROM acc_periods WHERE location_id = ? AND period = ? AND locked_at IS NOT NULL', locationId, periodOf(date));
}

/** The date an entry about `docDate` is booked on: that date, or – when its month is locked – the first day of the next open month. */
export function bookingDate(app: App, locationId: string, docDate: string): string {
  if (!lockedPeriod(app, locationId, docDate)) return docDate;
  const today = todayYmd(app, locationId);
  let d = docDate > today ? docDate : today;
  for (let i = 0; i < 60 && lockedPeriod(app, locationId, d); i++) {
    const [y, m] = periodOf(d).split('-').map(Number);
    d = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  }
  return d;
}

export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) (m = 1, y++);
    if (out.length > 600) break;
  }
  return out;
}

/** Locks every month from the earliest unlocked one with entries through `through` (YYYY-MM). Irreversible. */
export function lockThrough(app: App, locationId: string, through: string, user: { id: string | null; name: string }): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(through)) throw bad('Monat als JJJJ-MM angeben');
  const first = app.db.get<{ p: string | null }>(`SELECT MIN(period) AS p FROM acc_entries WHERE location_id = ?`, locationId)?.p;
  const start = first && first < through ? first : through;
  const locked: string[] = [];
  txn(app, () => {
    for (const p of monthRange(start, through)) {
      if (app.db.get('SELECT 1 FROM acc_periods WHERE location_id = ? AND period = ? AND locked_at IS NOT NULL', locationId, p)) continue;
      const at = now();
      app.db.run(
        `INSERT INTO acc_periods (id, location_id, period, locked_at, locked_by, locked_by_name) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(location_id, period) DO UPDATE SET locked_at = excluded.locked_at, locked_by = excluded.locked_by, locked_by_name = excluded.locked_by_name`,
        id(),
        locationId,
        p,
        at,
        user.id,
        user.name,
      );
      locked.push(p);
      trail(app, locationId, user, 'period.lock', null, p);
    }
  });
  return locked;
}
export function listPeriods(app: App, locationId: string, year: number) {
  const locked = new Map(app.db.all<{ period: string; locked_at: string; locked_by_name: string }>('SELECT period, locked_at, locked_by_name FROM acc_periods WHERE location_id = ? AND locked_at IS NOT NULL', locationId).map((r) => [r.period, r]));
  const counts = new Map(app.db.all<{ period: string; n: number }>(`SELECT period, COUNT(*) AS n FROM acc_entries WHERE location_id = ? AND period LIKE ? GROUP BY period`, locationId, `${year}-%`).map((r) => [r.period, r.n]));
  return Array.from({ length: 12 }, (_, i) => {
    const period = `${year}-${String(i + 1).padStart(2, '0')}`;
    const l = locked.get(period);
    return { period, locked: !!l, locked_at: l?.locked_at ?? null, locked_by: l?.locked_by_name ?? null, entries: counts.get(period) ?? 0 };
  });
}

// --- audit trail ------------------------------------------------------------------------

/** Append-only audit trail of the accounting (kept for good, unlike the general audit log). */
export function trail(app: App, locationId: string, user: { id?: string | null; name?: string } | null, action: string, entryId: string | null, detail = '') {
  app.db.run('INSERT INTO acc_audit (id, location_id, at, user_id, actor, action, entry_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id(), locationId, now(), user?.id ?? null, (user?.name ?? 'System').slice(0, 200), action.slice(0, 80), entryId, detail.slice(0, 500));
}

// --- posting ------------------------------------------------------------------------

function rowOut(row: any, lines: Line[]): EntryRow {
  let postings: Posting[] = [];
  try {
    postings = JSON.parse(row.postings);
  } catch {
    postings = [];
  }
  return { ...row, postings, lines };
}

export function getEntry(app: App, locationId: string, entryId: string): EntryRow | undefined {
  const row = app.db.get('SELECT * FROM acc_entries WHERE id = ? AND location_id = ?', entryId, locationId);
  if (!row) return undefined;
  return rowOut(row, app.db.all<Line>('SELECT account, side, cents, tax_code, is_tax, text FROM acc_lines WHERE entry_id = ? AND location_id = ? ORDER BY line_no', entryId, locationId));
}

export function entryBySourceKey(app: App, locationId: string, key: string): EntryRow | undefined {
  const row = app.db.get<{ id: string }>('SELECT id FROM acc_entries WHERE location_id = ? AND source_key = ?', locationId, key);
  return row ? getEntry(app, locationId, row.id) : undefined;
}

export function requireEnabled(app: App, locationId: string): AccSettings {
  const s = getSettings(app, locationId);
  if (!s.enabled) throw new HttpError(409, 'Die Buchhaltung ist noch nicht eingerichtet – bitte zuerst den Kontenrahmen wählen (Buchhaltung → Einstellungen).');
  return s;
}

/** Posts one entry. Idempotent per `source_key`. Throws German errors; nothing is written when a check fails. */
export function postEntry(app: App, locationId: string, input: EntryInput): { entry: EntryRow; created: boolean } {
  const settings = requireEnabled(app, locationId);
  if (input.source_key) {
    const existing = entryBySourceKey(app, locationId, input.source_key);
    if (existing) return { entry: existing, created: false };
  }
  const date = cleanDate(input.date, 'Buchungsdatum');
  const docDate = input.doc_date ? cleanDate(input.doc_date, 'Belegdatum') : date;
  const dueDate = input.due_date ? cleanDate(input.due_date, 'Fälligkeit') : null;
  const text = String(input.text ?? '').trim().slice(0, 200);
  if (!text) throw bad('Buchungstext fehlt');
  if (!Array.isArray(input.postings) || !input.postings.length) throw bad('Mindestens eine Buchung');
  if (input.postings.length > 200) throw bad('Zu viele Buchungszeilen (höchstens 200)');
  if (date < '2000-01-01' || date > '2100-12-31') throw bad('Buchungsdatum außerhalb des erlaubten Bereichs');
  if (lockedPeriod(app, locationId, date)) throw new HttpError(409, `Der Zeitraum ${periodOf(date)} ist festgeschrieben – gebucht werden kann nur in offenen Monaten (Korrekturen per Storno).`);
  const chart = chartMap(app, locationId);
  const postings = input.postings.map((p) => normalizePosting(p, chart, settings.mapping));
  const lines = postings.flatMap((p) => expandPosting(p, settings.mapping));
  for (const l of lines) if (!chart.get(l.account)) throw bad(`Konto ${l.account} fehlt im Kontenrahmen`);
  const bal = balance(lines);
  if (!bal.balanced) throw bad('Die Buchung ist nicht ausgeglichen (Soll ≠ Haben)');
  const user = { id: input.user_id ?? null, name: input.actor ?? 'System' };
  return txn(app, () => {
    const last = app.db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM acc_entries WHERE location_id = ? ORDER BY seq DESC LIMIT 1', locationId);
    const seq = (last?.seq ?? 0) + 1;
    const number = `B-${String(seq).padStart(6, '0')}`;
    const prev = last?.hash ?? '';
    const base = { seq, number, date, doc_date: docDate, text, doc_ref: String(input.doc_ref ?? '').trim().slice(0, 60), source_key: input.source_key ?? null, postings, lines };
    const hash = entryHash(prev, base);
    const entryId = id();
    app.db.run(
      `INSERT INTO acc_entries (id, location_id, seq, number, date, doc_date, due_date, period, text, doc_ref, source, source_id, source_key, postings, currency, party_name, contact_id, receipt_id, document_id, reverses_id, prev_hash, hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entryId,
      locationId,
      seq,
      number,
      date,
      docDate,
      dueDate,
      periodOf(date),
      text,
      base.doc_ref,
      input.source ?? 'manual',
      input.source_id ?? null,
      base.source_key,
      JSON.stringify(postings),
      String(input.party_name ?? '').slice(0, 200),
      input.contact_id ?? null,
      input.receipt_id ?? null,
      input.document_id ?? null,
      input.reverses_id ?? null,
      prev,
      hash,
      input.user_id ?? null,
      now(),
    );
    lines.forEach((l, i) => app.db.run('INSERT INTO acc_lines (id, entry_id, location_id, line_no, account, side, cents, tax_code, is_tax, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id(), entryId, locationId, i + 1, l.account, l.side, l.cents, l.tax_code, l.is_tax, l.text));
    trail(app, locationId, user, input.reverses_id ? 'entry.storno' : 'entry.post', entryId, `${number} ${text}`.slice(0, 200));
    return { entry: getEntry(app, locationId, entryId)!, created: true };
  });
}

/** Cancels an entry by a counter-entry on `date` (default: today, or the first open day). The original stays untouched. */
export function stornoEntry(app: App, locationId: string, entryId: string, opts: { date?: string; reason?: string; user?: { id: string | null; name: string } } = {}): EntryRow {
  const orig = getEntry(app, locationId, entryId);
  if (!orig) throw notFound('Buchung nicht gefunden');
  if (orig.reversed_by) throw bad('Diese Buchung wurde schon storniert');
  if (orig.reverses_id) throw bad('Eine Storno-Buchung lässt sich nicht erneut stornieren – bitte neu buchen');
  const date = opts.date ? cleanDate(opts.date, 'Stornodatum') : bookingDate(app, locationId, todayYmd(app, locationId));
  const reason = String(opts.reason ?? '').trim().slice(0, 120);
  const postings: PostingIn[] = orig.postings.map((p) => ({
    // Same tax code and amounts, sides swapped: the expansion yields exactly the opposite lines.
    debit: p.credit,
    credit: p.debit,
    amount_cents: p.amount_cents,
    tax_code: p.tax_code,
    net_cents: p.net_cents,
    tax_cents: p.tax_cents,
    text: p.text,
  }));
  const { entry } = txn(app, () => {
    const out = postEntry(app, locationId, {
      date,
      doc_date: orig.doc_date,
      due_date: orig.due_date,
      text: `Storno ${orig.number}${reason ? `: ${reason}` : ''} – ${orig.text}`.slice(0, 200),
      doc_ref: orig.doc_ref,
      source: 'storno',
      source_id: orig.id,
      postings,
      party_name: orig.party_name,
      contact_id: orig.contact_id,
      receipt_id: null,
      reverses_id: orig.id,
      user_id: opts.user?.id ?? null,
      actor: opts.user?.name,
    });
    app.db.run('UPDATE acc_entries SET reversed_by = ? WHERE id = ? AND location_id = ? AND reversed_by IS NULL', out.entry.id, orig.id, locationId);
    return out;
  });
  return entry;
}

/** Recomputes the hash chain: any entry changed behind the application's back shows up. */
export function verifyChain(app: App, locationId: string): { ok: boolean; checked: number; broken_at: string | null; reason: string } {
  let prev = '';
  let checked = 0;
  const rows = app.db.all<any>('SELECT * FROM acc_entries WHERE location_id = ? ORDER BY seq', locationId);
  let expectSeq = 1;
  for (const r of rows) {
    const lines = app.db.all<Line>('SELECT account, side, cents, tax_code, is_tax FROM acc_lines WHERE entry_id = ? AND location_id = ? ORDER BY line_no', r.id, locationId);
    let postings: unknown = [];
    try {
      postings = JSON.parse(r.postings);
    } catch {
      /* broken */
    }
    const want = entryHash(prev, { seq: r.seq, number: r.number, date: r.date, doc_date: r.doc_date, text: r.text, doc_ref: r.doc_ref, source_key: r.source_key, postings, lines });
    if (r.seq !== expectSeq) return { ok: false, checked, broken_at: r.number, reason: `Lücke in der Nummerierung vor ${r.number}` };
    if (r.prev_hash !== prev || r.hash !== want) return { ok: false, checked, broken_at: r.number, reason: `Buchung ${r.number} wurde nachträglich verändert` };
    if (!balance(lines).balanced) return { ok: false, checked, broken_at: r.number, reason: `Buchung ${r.number} ist nicht ausgeglichen` };
    prev = r.hash;
    expectSeq++;
    checked++;
  }
  return { ok: true, checked, broken_at: null, reason: '' };
}

/** Runs `fn` in a transaction – or inside the one that is already open (nested postings, e.g. a storno). */
export const txn = <T>(app: App, fn: () => T): T => (app.db.raw.isTransaction ? fn() : app.db.tx(fn));

export const MAPPING_FIELD_KEYS: readonly string[] = MAPPING_KEYS;
