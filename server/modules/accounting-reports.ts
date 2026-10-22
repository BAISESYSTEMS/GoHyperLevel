import type { Module } from '../core/app.js';
import { bad, type Ctx } from '../core/http.js';
import { moneyDe, semicolonCsv } from '../services/bo-common.js';
import { buildExtf, encodeCp1252, parseExtf, EXTF_FIELDS } from '../services/acc-datev.js';
import { datevBeleglinks, datevDocumentsArchive } from '../services/acc-datev-docs.js';
import { chartMap, cleanDate, getEntry, getSettings, requireEnabled, todayYmd, trail, type EntryRow } from '../services/acc-ledger.js';
import { bwa, cleanRange, euer, fiscalYearStart, openItems, susa, ustva } from '../services/acc-reports.js';
import { actor } from './accounting.js';

/** Reports (EÜR, SuSa, BWA, USt-Voranmeldung overview, open items) and the exports for the tax advisor (DATEV, documents). */

const money = moneyDe;
const csv = semicolonCsv;
const file = (name: string, type: string, body: string | Buffer) => ({ __raw: true as const, status: 200, headers: { 'content-type': type, 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }, body });

export const reportsModule: Module = {
  name: 'accounting-reports',
  register(app) {
    const { db, router } = app;

    // Downloads the automatic export log (security module) does not recognise by their path.
    const exported = (ctx: Ctx, what: string, summary: string) => app.services.audit?.({ ctx, action: `export:accounting/${what}`, route: `GET /api/accounting/${what}`, summary });

    /** The current year in the sub-account's time zone: the default report period (on 1 January at 00:30 in Berlin it is the new year already). */
    const localYear = (loc: string) => Number(todayYmd(app, loc).slice(0, 4));
    const range = (q: URLSearchParams, loc: string) => {
      const year = q.get('year');
      if (year) {
        if (!/^\d{4}$/.test(year)) throw bad('Jahr ungültig');
        return { from: `${year}-01-01`, to: `${year}-12-31` };
      }
      return cleanRange(q.get('from'), q.get('to'), localYear(loc));
    };

    router.get('/api/accounting/reports/susa', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = range(ctx.query, ctx.locationId);
      const out = susa(app, ctx.locationId, r.from, r.to);
      if (ctx.query.get('format') === 'csv') {
        exported(ctx, 'reports/susa', `${r.from} bis ${r.to}`);
        return file(`SuSa_${r.from}_${r.to}.csv`, 'text/csv; charset=utf-8', csv([['Konto', 'Bezeichnung', 'Anfangssaldo', 'Soll', 'Haben', 'Endsaldo'], ...out.rows.map((x) => [x.account, x.name, money(x.opening_cents), money(x.debit_cents), money(x.credit_cents), money(x.closing_cents)])]));
      }
      return out;
    });
    router.get('/api/accounting/reports/bwa', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = range(ctx.query, ctx.locationId);
      return bwa(app, ctx.locationId, r.from, r.to, { months: ctx.query.get('months') === '1' });
    });
    router.get('/api/accounting/reports/euer', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = range(ctx.query, ctx.locationId);
      return euer(app, ctx.locationId, r.from, r.to);
    });
    router.get('/api/accounting/reports/ustva', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      return ustva(app, ctx.locationId, String(ctx.query.get('period') ?? ''));
    });
    router.get('/api/accounting/reports/open-items', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const type = ctx.query.get('type') === 'payable' ? 'payable' : 'receivable';
      const asof = ctx.query.get('asof') ? cleanDate(ctx.query.get('asof'), 'Stichtag') : todayYmd(app, ctx.locationId);
      return openItems(app, ctx.locationId, type, asof);
    });

    // The journal as a spreadsheet (one row per line).
    router.get('/api/accounting/reports/journal.csv', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = range(ctx.query, ctx.locationId);
      const chart = chartMap(app, ctx.locationId);
      const rows = db.all<any>(
        `SELECT e.number, e.date, e.doc_date, e.doc_ref, e.text, e.party_name, e.source, l.account, l.side, l.cents, l.tax_code
         FROM acc_entries e JOIN acc_lines l ON l.entry_id = e.id WHERE e.location_id = ? AND e.date >= ? AND e.date <= ? ORDER BY e.seq, l.line_no`,
        ctx.locationId, r.from, r.to,
      );
      return file(
        `Buchungsjournal_${r.from}_${r.to}.csv`,
        'text/csv; charset=utf-8',
        csv([['Nr', 'Buchungsdatum', 'Belegdatum', 'Belegnummer', 'Text', 'Partner', 'Quelle', 'Konto', 'Kontoname', 'Soll', 'Haben', 'Steuerschlüssel'], ...rows.map((x) => [x.number, x.date, x.doc_date, x.doc_ref, x.text, x.party_name, x.source, x.account, chart.get(x.account)?.name ?? '', x.side === 'S' ? money(x.cents) : '', x.side === 'H' ? money(x.cents) : '', x.tax_code])]),
      );
    });

    // --- DATEV --------------------------------------------------------------------------------------------------
    const entriesIn = (loc: string, from: string, to: string): EntryRow[] =>
      db.all<{ id: string }>('SELECT id FROM acc_entries WHERE location_id = ? AND date >= ? AND date <= ? ORDER BY seq', loc, from, to).map((r) => getEntry(app, loc, r.id)!).filter(Boolean);

    const datevCheck = (loc: string, from: string, to: string) => {
      const s = getSettings(app, loc);
      const warnings: string[] = [];
      if (!s.datev.berater || !s.datev.mandant) warnings.push('Beraternummer und Mandantennummer fehlen (Einstellungen → DATEV) – ohne sie lehnt DATEV den Import ab.');
      const unlocked = db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT e.period) AS n FROM acc_entries e WHERE e.location_id = ? AND e.date >= ? AND e.date <= ? AND NOT EXISTS (SELECT 1 FROM acc_periods p WHERE p.location_id = e.location_id AND p.period = e.period AND p.locked_at IS NOT NULL)`,
        loc, from, to,
      )?.n ?? 0;
      if (unlocked) warnings.push(unlocked === 1 ? '1 Monat im Zeitraum ist noch nicht festgeschrieben.' : `${unlocked} Monate im Zeitraum sind noch nicht festgeschrieben.`);
      const inbox = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM acc_receipts WHERE location_id = ? AND status IN ('inbox', 'review')`, loc)?.n ?? 0;
      if (inbox) warnings.push(inbox === 1 ? '1 Beleg im Eingang ist noch nicht gebucht.' : `${inbox} Belege im Eingang sind noch nicht gebucht.`);
      const bank = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM acc_bank_txns WHERE location_id = ? AND status IN ('open', 'matched') AND booking_date >= ? AND booking_date <= ?`, loc, from, to)?.n ?? 0;
      if (bank) warnings.push(bank === 1 ? '1 Bankumsatz im Zeitraum ist noch nicht gebucht.' : `${bank} Bankumsätze im Zeitraum sind noch nicht gebucht.`);
      return { settings: s, warnings };
    };

    router.get('/api/accounting/datev/preview', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = cleanRange(ctx.query.get('from'), ctx.query.get('to'), localYear(ctx.locationId));
      const { warnings } = datevCheck(ctx.locationId, r.from, r.to);
      const entries = entriesIn(ctx.locationId, r.from, r.to);
      return { ...r, entries: entries.length, rows: entries.reduce((n, e) => n + e.postings.length, 0), warnings, format: 'EXTF 700, Buchungsstapel (Kategorie 21, Version 13), Windows-1252' };
    });

    router.get('/api/accounting/datev/export', 'location', (ctx) => {
      const settings = requireEnabled(app, ctx.locationId);
      const r = cleanRange(ctx.query.get('from'), ctx.query.get('to'), localYear(ctx.locationId));
      if (!settings.datev.berater || !settings.datev.mandant) throw bad('Bitte zuerst Beraternummer und Mandantennummer eintragen (Buchhaltung → Einstellungen → DATEV)');
      const entries = entriesIn(ctx.locationId, r.from, r.to);
      if (!entries.length) throw bad('Im Zeitraum gibt es keine Buchungen');
      const built = buildExtf({
        entries,
        chart: chartMap(app, ctx.locationId),
        standard: settings.standard,
        berater: settings.datev.berater,
        mandant: settings.datev.mandant,
        accountLength: settings.datev.account_length,
        fyStart: fiscalYearStart(r.from, settings.fy_start_month),
        from: r.from,
        to: r.to,
        name: settings.datev.name,
        // Beleglink (BEDI GUID) to the documents ZIP below; beleglink=0 leaves the column empty
        ...(ctx.query.get('beleglink') === '0' ? {} : { beleglink: datevBeleglinks(app, ctx.locationId) }),
      });
      // Sanity check before the file leaves: every data row has exactly the 125 fields.
      const rows = parseExtf(built.text);
      if (rows.slice(2).some((x) => x.length !== EXTF_FIELDS)) throw new Error('Interner Fehler: Zeilenlänge im DATEV-Export');
      const a = actor(ctx);
      trail(app, ctx.locationId, a, 'datev.export', null, `${r.from} bis ${r.to}: ${entries.length} Buchungen, ${built.rows} Zeilen`);
      return file(`EXTF_Buchungsstapel_${r.from}_${r.to}.csv`, 'text/csv; charset=windows-1252', encodeCp1252(built.text));
    });

    // Documents of the booked receipts and invoices in a period: a ZIP with DATEV's document.xml, the files and an index
    // (booking ↔ file ↔ hash ↔ GUID). index=0 leaves the index out (Belegtransfer only needs document.xml and the files),
    // process=archive sends the documents as archive documents (processID 2) instead of "buchungsrelevant".
    router.get('/api/accounting/datev/documents', 'location', (ctx) => {
      requireEnabled(app, ctx.locationId);
      const r = cleanRange(ctx.query.get('from'), ctx.query.get('to'), localYear(ctx.locationId));
      const out = datevDocumentsArchive(app, ctx.locationId, r.from, r.to, { index: ctx.query.get('index') !== '0', process: ctx.query.get('process') === 'archive' ? 2 : 1 });
      exported(ctx, 'datev/documents', `${r.from} bis ${r.to}`);
      trail(app, ctx.locationId, actor(ctx), 'datev.documents', null, `${r.from} bis ${r.to}: ${out.documents} Belege${out.missing ? `, ${out.missing} Dateien fehlen` : ''}`);
      return file(`Belege_${r.from}_${r.to}.zip`, 'application/zip', out.zip);
    });
  },
};
