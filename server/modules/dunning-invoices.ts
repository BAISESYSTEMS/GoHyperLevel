import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, type Ctx, type RawResult } from '../core/http.js';
import { render } from '../core/template.js';
import { id, now, token } from '../core/util.js';
import { contactVars, getContact, logActivity } from '../services/contacts.js';
import { auditLog, clip, deDate, limiter, money } from '../services/creator-kit.js';
import { dunningPdf } from '../services/dunning-pdf.js';
import { daysOverdue, deadlineOf, nextLevel, noticeAmounts, type DunningSettings, type InvSettings } from '../services/dunning-model.js';
import { openCents, overdueBefore } from '../services/invoice-model.js';
import { sendToContact } from '../services/messaging.js';
import { registerActions, registerTriggers, text as fill } from '../services/wfx-kit.js';

/**
 * Mahnstufen for invoices: Zahlungserinnerung, 1. und 2. Mahnung after configurable days past the due date, with a fee per
 * level and default interest (§ 288 BGB: base rate + 5 points for consumers, + 9 for businesses, plus the 40 € flat fee
 * between businesses). Runs by itself ("auto"), asks first ("approval") or stays off; stops the moment the invoice is paid or
 * put on hold. Every notice is an e-mail (optionally SMS) with a link to its PDF; every step is in the audit log.
 * Docs: docs/dunning.md.
 */

interface Notice {
  id: string;
  location_id: string;
  invoice_id: string;
  contact_id: string | null;
  level: number;
  level_key: string;
  label: string;
  status: 'pending' | 'sent' | 'failed' | 'dismissed' | 'canceled';
  source: string;
  principal_cents: number;
  prior_fee_cents: number;
  fee_cents: number;
  interest_cents: number;
  flat_fee_cents: number;
  total_cents: number;
  interest_rate: number;
  days_overdue: number;
  currency: string;
  deadline_at: string | null;
  token: string;
  subject: string;
  body: string;
  edited: number;
  channels: string;
  error: string;
  created_at: string;
  sent_at: string | null;
}

const PDF_LIMIT = limiter(60, 10 * 60_000);

export const dunningInvoicesModule: Module = {
  name: 'dunning-invoices',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE dunning_notices (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        level INTEGER NOT NULL, level_key TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT 'auto',
        principal_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0, interest_cents INTEGER NOT NULL DEFAULT 0, flat_fee_cents INTEGER NOT NULL DEFAULT 0,
        total_cents INTEGER NOT NULL, interest_rate REAL NOT NULL DEFAULT 0, days_overdue INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR',
        deadline_at TEXT, token TEXT NOT NULL UNIQUE, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', edited INTEGER NOT NULL DEFAULT 0,
        channels TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, sent_at TEXT, decided_by TEXT,
        UNIQUE(invoice_id, level)
      );
      CREATE INDEX dunning_notices_loc ON dunning_notices(location_id, status);
      CREATE INDEX dunning_notices_invoice ON dunning_notices(invoice_id);
      CREATE TABLE dunning_holds (
        invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, user_id TEXT
      );
      `,
    ],
    // Fees of the earlier notices that were sent, claimed again by a later one (Mahngebühren früherer Schreiben).
    ['002-prior-fees', `ALTER TABLE dunning_notices ADD COLUMN prior_fee_cents INTEGER NOT NULL DEFAULT 0;`],
  ],
  register(app) {
    const { db, router } = app;
    const settings = (loc: string): DunningSettings => app.services.dunning.settings(loc);
    const invoiceOf = (loc: string, invoiceId: string) => {
      const r = db.get<any>('SELECT * FROM invoices WHERE id = ? AND location_id = ?', invoiceId, loc);
      if (r) r.items = JSON.parse(r.items || '[]');
      return r;
    };
    const holdOf = (invoiceId: string) => db.get<any>('SELECT * FROM dunning_holds WHERE invoice_id = ?', invoiceId);
    const lastNotice = (invoiceId: string) => db.get<Notice>(`SELECT * FROM dunning_notices WHERE invoice_id = ? AND status IN ('pending', 'sent') ORDER BY level DESC LIMIT 1`, invoiceId);
    const lastSent = (invoiceId: string) => db.get<Notice>(`SELECT * FROM dunning_notices WHERE invoice_id = ? AND status = 'sent' ORDER BY level DESC LIMIT 1`, invoiceId);
    const unpaid = (inv: any) => inv && inv.kind === 'invoice' && inv.status === 'sent';
    /** Days overdue are calendar days of the sub-account's zone (services/invoice-model.ts daysOverdue). */
    const tzOf = (loc: string) => app.location(loc)?.timezone || 'Europe/Berlin';

    // --- one notice: amounts, text, PDF ----------------------------------------------------------------------------------
    /** Fees of the notices of earlier levels that went out – still owed, so a later notice claims them again (setting `carry_fees`). */
    const priorFees = (invoiceId: string, level: number) =>
      Number(db.get<{ n: number }>(`SELECT COALESCE(SUM(fee_cents), 0) AS n FROM dunning_notices WHERE invoice_id = ? AND status = 'sent' AND level < ?`, invoiceId, level)?.n ?? 0);
    function compose(inv: any, contact: any, s: InvSettings, index: number, at = new Date()) {
      const level = s.levels[index];
      const a = noticeAmounts(s, index, { principal_cents: openCents(inv), due_at: inv.due_at ?? inv.issued_at, at, company: contact?.company, tz: tzOf(inv.location_id), prior_fee_cents: priorFees(inv.id, index + 1) });
      const deadline = deadlineOf(level, at);
      return { level, a, deadline };
    }
    function renderText(n: Pick<Notice, 'token' | 'currency' | 'deadline_at' | 'principal_cents' | 'prior_fee_cents' | 'fee_cents' | 'interest_cents' | 'flat_fee_cents' | 'total_cents'>, level: { subject: string; body: string; label: string }, inv: any, contact: any, loc: string) {
      const tz = app.location(loc)?.timezone ?? 'Europe/Berlin';
      const vars = {
        contact: contactVars(contact),
        location: app.location(loc),
        invoice: { number: inv.number, total: money(inv.total_cents, inv.currency), date: deDate(inv.issued_at, tz), due: deDate(inv.due_at, tz), url: `${app.baseUrl()}/i/${inv.public_token}`, title: inv.title },
        notice: {
          label: level.label,
          fee: money(n.fee_cents, n.currency),
          prior_fees: money(n.prior_fee_cents ?? 0, n.currency),
          fees: money((n.prior_fee_cents ?? 0) + n.fee_cents, n.currency),
          interest: money(n.interest_cents, n.currency),
          flat_fee: money(n.flat_fee_cents, n.currency),
          total: money(n.total_cents, n.currency),
          deadline: deDate(n.deadline_at, tz),
          pdf_url: `${app.baseUrl()}/mahnung/${n.token}/pdf`,
        },
      };
      return { subject: render(level.subject, vars as any), body: render(level.body, vars as any) };
    }

    function pdfOf(n: Notice): Buffer {
      const inv = invoiceOf(n.location_id, n.invoice_id);
      const contact = n.contact_id ? getContact(app, n.location_id, n.contact_id) : undefined;
      const loc = app.location(n.location_id)!;
      const inf = loc.settings.invoices ?? {};
      const brand = loc.settings.branding ?? {};
      const s = settings(n.location_id).inv;
      const level = s.levels.find((l) => l.key === n.level_key) ?? s.levels[n.level - 1] ?? s.levels[0];
      const body = renderText(n, { ...level, subject: '', body: level.body }, inv, contact, n.location_id)
        .body.split('\n')
        .filter((l) => !/^(Rechnung ansehen und bezahlen|Schreiben als PDF):/.test(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return dunningPdf({
        title: n.label,
        brand: { name: brand.name || loc.name, address: loc.address ?? '', email: loc.email ?? '', tax_id: inf.tax_id ?? '', color: brand.color, iban: inf.iban ?? '', bic: inf.bic ?? '', bank: inf.bank ?? '' },
        recipient: { name: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '', company: contact?.company ?? '', address: contact?.address ?? '', postal_code: contact?.postal_code ?? '', city: contact?.city ?? '', country: contact?.country ?? '' },
        date: n.sent_at ?? n.created_at,
        tz: loc.timezone,
        reference: { number: inv.number, issued_at: inv.issued_at, due_at: inv.due_at ?? inv.issued_at },
        currency: n.currency,
        amounts: { principal_cents: n.principal_cents, prior_fee_cents: n.prior_fee_cents ?? 0, fee_cents: n.fee_cents, interest_cents: n.interest_cents, flat_fee_cents: n.flat_fee_cents, total_cents: n.total_cents, rate: n.interest_rate, days: n.days_overdue },
        levelLabel: n.label,
        deadline: deDate(n.deadline_at, loc.timezone),
        body,
        invoiceUrl: `${app.baseUrl()}/i/${inv.public_token}`,
        smallBusiness: !!inf.small_business,
      });
    }

    function create(loc: string, inv: any, index: number, source: string): Notice {
      const s = settings(loc).inv;
      const contact = inv.contact_id ? getContact(app, loc, inv.contact_id) : undefined;
      const { level, a, deadline } = compose(inv, contact, s, index);
      const base = { token: token(18), currency: inv.currency, deadline_at: deadline.toISOString(), principal_cents: a.principal_cents, prior_fee_cents: a.prior_fee_cents, fee_cents: a.fee_cents, interest_cents: a.interest_cents, flat_fee_cents: a.flat_fee_cents, total_cents: a.total_cents };
      const t = renderText(base, level, inv, contact, loc);
      const row = {
        id: id(), location_id: loc, invoice_id: inv.id, contact_id: inv.contact_id ?? null, level: index + 1, level_key: level.key, label: level.label, status: 'pending', source,
        ...base, interest_rate: a.rate, days_overdue: a.days, subject: t.subject, body: t.body, edited: 0, channels: [], error: '', created_at: now(),
      };
      db.insert('dunning_notices', row);
      return db.get<Notice>('SELECT * FROM dunning_notices WHERE id = ?', row.id)!;
    }

    /**
     * Notices on their way right now. "Jetzt senden" clicked twice, two people approving the same notice or a workflow step at the
     * same time: the second one is refused instead of mailing the customer the same Mahnung (with its fees) again.
     */
    const sending = new Set<string>();

    /** Sends a notice (e-mail, optionally SMS), checking once more that the invoice is still open and not on hold. */
    async function send(n: Notice, by: string): Promise<Notice> {
      if (sending.has(n.id)) throw new HttpError(409, 'Diese Mahnung wird gerade gesendet');
      const cur = db.get<{ status: string }>('SELECT status FROM dunning_notices WHERE id = ?', n.id);
      if (cur && cur.status !== 'pending' && cur.status !== 'failed') throw new HttpError(409, 'Diese Mahnung wurde schon bearbeitet');
      sending.add(n.id);
      try {
        return await sendNotice(n, by);
      } finally {
        sending.delete(n.id);
      }
    }

    async function sendNotice(n: Notice, by: string): Promise<Notice> {
      const inv = invoiceOf(n.location_id, n.invoice_id);
      const cancel = (why: string) => {
        db.run(`UPDATE dunning_notices SET status = 'canceled', error = ?, decided_by = ? WHERE id = ?`, why, by, n.id);
        return db.get<Notice>('SELECT * FROM dunning_notices WHERE id = ?', n.id)!;
      };
      if (!inv || inv.status === 'paid' || inv.status === 'void') return cancel(inv?.status === 'paid' ? 'Rechnung ist bezahlt' : 'Rechnung ist storniert');
      if (!unpaid(inv)) return cancel('Rechnung ist nicht offen');
      if (holdOf(inv.id)) return cancel('Mahnstopp gesetzt');
      const contact = n.contact_id ? getContact(app, n.location_id, n.contact_id) : undefined;
      if (!contact) return cancel('Kontakt fehlt');
      const s = settings(n.location_id).inv;
      const index = Math.max(0, s.levels.findIndex((l) => l.key === n.level_key));
      const { level, a, deadline } = compose(inv, contact, s, index);
      // Interest runs until the day of sending; a text the team edited stays as it is.
      const fresh = { ...n, principal_cents: a.principal_cents, prior_fee_cents: a.prior_fee_cents, fee_cents: a.fee_cents, interest_cents: a.interest_cents, flat_fee_cents: a.flat_fee_cents, total_cents: a.total_cents, interest_rate: a.rate, days_overdue: a.days, deadline_at: deadline.toISOString() };
      const t = n.edited ? { subject: n.subject, body: renderText(fresh, { ...level, body: n.body, subject: n.subject }, inv, contact, n.location_id).body } : renderText(fresh, level, inv, contact, n.location_id);
      const channels: string[] = [];
      let error = '';
      let ok = false;
      if (contact.email) {
        const m = await sendToContact(app, n.location_id, { contactId: contact.id, channel: 'email', subject: t.subject, body: t.body, source: level.label, ignoreDnd: true });
        channels.push('email');
        ok = m.status !== 'failed';
        if (!ok) error = String(m.error ?? '');
      }
      if (s.sms && contact.phone) {
        const m = await sendToContact(app, n.location_id, { contactId: contact.id, channel: 'sms', body: `${level.label} zu Rechnung ${inv.number}: ${money(a.total_cents, inv.currency)} bis ${deDate(deadline, app.location(n.location_id)?.timezone)}. ${app.baseUrl()}/i/${inv.public_token}`, source: level.label, ignoreDnd: true });
        channels.push('sms');
        ok = ok || m.status !== 'failed';
      }
      if (!ok) {
        db.run(`UPDATE dunning_notices SET status = 'failed', error = ?, decided_by = ? WHERE id = ?`, error || 'Kein Kanal erreichbar (E-Mail oder Telefon fehlt)', by, n.id);
        auditLog(app, undefined, n.location_id, 'dunning.notice_failed', `${level.label} zu ${inv.number} nicht gesendet: ${error || 'kein Kanal'}`, n.id, by);
        return db.get<Notice>('SELECT * FROM dunning_notices WHERE id = ?', n.id)!;
      }
      db.run(
        `UPDATE dunning_notices SET status = 'sent', sent_at = ?, channels = ?, error = '', decided_by = ?, subject = ?, body = ?, principal_cents = ?, prior_fee_cents = ?, fee_cents = ?, interest_cents = ?, flat_fee_cents = ?, total_cents = ?, interest_rate = ?, days_overdue = ?, deadline_at = ? WHERE id = ?`,
        now(), JSON.stringify(channels), by, t.subject, t.body, fresh.principal_cents, fresh.prior_fee_cents, fresh.fee_cents, fresh.interest_cents, fresh.flat_fee_cents, fresh.total_cents, fresh.interest_rate, fresh.days_overdue, fresh.deadline_at, n.id,
      );
      const sent = db.get<Notice>('SELECT * FROM dunning_notices WHERE id = ?', n.id)!;
      logActivity(app, n.location_id, contact.id, 'invoice.dunning', `${level.label} zu Rechnung ${inv.number} gesendet (Forderung ${money(sent.total_cents, sent.currency)}, fällig bis ${deDate(sent.deadline_at, app.location(n.location_id)?.timezone)})`);
      auditLog(app, undefined, n.location_id, 'dunning.notice_sent', `${level.label} zu ${inv.number} gesendet (${money(sent.total_cents, sent.currency)}, ${channels.join('+')})`, n.id, by);
      app.events.emit(n.location_id, 'invoice.dunning_sent', {
        contactId: contact.id,
        noticeId: n.id,
        invoice: { id: inv.id, number: inv.number, total_cents: inv.total_cents, currency: inv.currency, due_at: inv.due_at },
        level: n.level,
        level_key: n.level_key,
        label: level.label,
        prior_fee_cents: sent.prior_fee_cents,
        fee_cents: sent.fee_cents,
        interest_cents: sent.interest_cents,
        flat_fee_cents: sent.flat_fee_cents,
        total_cents: sent.total_cents,
        deadline_at: sent.deadline_at,
        pdf_url: `${app.baseUrl()}/mahnung/${sent.token}/pdf`,
      });
      return sent;
    }

    // --- the run ----------------------------------------------------------------------------------------------------------------
    interface Candidate {
      invoice: any;
      index: number;
      amounts: ReturnType<typeof noticeAmounts>;
      label: string;
      days: number;
      held: boolean;
    }
    function candidates(loc: string, opts: { invoiceId?: string; force?: boolean; at?: Date } = {}): Candidate[] {
      const s = settings(loc).inv;
      const at = opts.at ?? new Date();
      const rows = db.all<any>(
        `SELECT * FROM invoices WHERE location_id = ? AND kind = 'invoice' AND status = 'sent' AND total_cents - paid_cents - credited_cents - deducted_cents > 0 AND contact_id IS NOT NULL AND due_at IS NOT NULL AND due_at < ? ${opts.invoiceId ? 'AND id = ?' : ''} ORDER BY due_at LIMIT 300`,
        loc,
        at.toISOString(),
        ...(opts.invoiceId ? [opts.invoiceId] : []),
      );
      const out: Candidate[] = [];
      for (const inv of rows) {
        // the minimum is about what is still owed: a short payment that leaves a few cents open is no reason for a notice with fees
        if (openCents(inv) < s.min_amount_cents && !opts.force) continue;
        const last = lastNotice(inv.id);
        const sent = lastSent(inv.id);
        // A pending notice has to be decided first.
        if (last?.status === 'pending') continue;
        let index = nextLevel(s, { due_at: inv.due_at, last_level: last?.level ?? 0, last_sent_at: sent?.sent_at ?? null, at, tz: tzOf(loc) });
        if (index === null && opts.force) index = Math.min(last?.level ?? 0, s.levels.length - 1);
        if (index === null || (opts.force && (last?.level ?? 0) >= s.levels.length)) continue;
        const contact = getContact(app, loc, inv.contact_id);
        const { level, a } = compose(inv, contact, s, index, at);
        out.push({ invoice: inv, index, amounts: a, label: level.label, days: daysOverdue(inv.due_at, at, tzOf(loc)), held: !!holdOf(inv.id) });
      }
      return out;
    }

    async function run(loc: string, o: { dry?: boolean; invoiceId?: string; by?: string; force?: boolean; send?: 'now' | 'draft' } = {}) {
      const s = settings(loc).inv;
      if (s.mode === 'off' && !o.force) return { mode: s.mode, created: [] as any[], sent: [] as any[], skipped: 0 };
      // A single invoice picked by hand follows the mode (off counts as "ask first"); the team may force sending or a draft.
      const mode = o.send === 'now' ? 'auto' : o.send === 'draft' ? 'approval' : s.mode === 'off' ? 'approval' : s.mode;
      const list = candidates(loc, { invoiceId: o.invoiceId, force: !!o.force });
      const view = list.map((c) => ({ invoice_id: c.invoice.id, number: c.invoice.number, level: c.index + 1, label: c.label, days_overdue: c.days, total_cents: c.amounts.total_cents, held: c.held }));
      if (o.dry) return { mode: s.mode, dry_run: true, due: view, created: [], sent: [], skipped: list.filter((c) => c.held).length };
      const created: any[] = [];
      const sent: any[] = [];
      for (const c of list) {
        if (c.held) continue;
        const exists = db.get('SELECT 1 FROM dunning_notices WHERE invoice_id = ? AND level = ?', c.invoice.id, c.index + 1);
        if (exists) continue;
        const n = create(loc, c.invoice, c.index, o.force ? 'manual' : 'auto');
        created.push({ id: n.id, invoice_id: n.invoice_id, number: c.invoice.number, label: n.label });
        auditLog(app, undefined, loc, 'dunning.notice_created', `${n.label} zu ${c.invoice.number} angelegt (${mode === 'auto' ? 'Versand' : 'zur Freigabe'})`, n.id, o.by);
        if (mode === 'auto') {
          const r = await send(n, o.by ?? 'Automatik');
          sent.push({ id: r.id, number: c.invoice.number, label: r.label, status: r.status });
        } else {
          void Promise.resolve(app.services.pushNotify?.({ locationId: loc, kind: 'payments', title: `${n.label} wartet auf Freigabe`, body: `Rechnung ${c.invoice.number}`, url: '/app/dunning', tag: `dunning-${n.id}` })).catch(() => undefined);
        }
      }
      return { mode: s.mode, created, sent, skipped: list.filter((c) => c.held).length };
    }

    let lastRun = 0;
    app.onTick(async () => {
      if (Date.now() - lastRun < 30 * 60_000) return;
      lastRun = Date.now();
      for (const r of db.all<{ location_id: string }>('SELECT location_id FROM dunning_settings')) {
        try {
          if (settings(r.location_id).inv.mode !== 'off') await run(r.location_id);
        } catch (e) {
          console.error('[dunning] Mahnlauf', (e as Error).message);
        }
      }
    });

    // Stop on payment: pending notices for the invoice are withdrawn at once.
    app.events.on('invoice.paid', (e) => {
      const inv = e.data.invoice;
      if (!inv?.id) return;
      const n = db.run(`UPDATE dunning_notices SET status = 'canceled', error = 'Rechnung ist bezahlt' WHERE invoice_id = ? AND status = 'pending'`, inv.id).changes;
      if (n) auditLog(app, undefined, e.locationId, 'dunning.stopped', `Rechnung ${inv.number} bezahlt – ${n} offene Mahnung(en) zurückgezogen`, inv.id);
    });
    // …and when nothing is owed any more for another reason: cancelled by a Storno, or credited (Gutschrift) down to nothing.
    const withdraw = (locationId: string, inv: { id: string; number: string }, why: string) => {
      const n = db.run(`UPDATE dunning_notices SET status = 'canceled', error = ? WHERE invoice_id = ? AND status = 'pending'`, why, inv.id).changes;
      if (n) auditLog(app, undefined, locationId, 'dunning.stopped', `Rechnung ${inv.number}: ${why} – ${n} offene Mahnung(en) zurückgezogen`, inv.id);
    };
    app.events.on('invoice.cancelled', (e) => {
      if (e.data.invoice?.id) withdraw(e.locationId, e.data.invoice, 'Rechnung ist storniert');
    });
    app.events.on('invoice.finalised', (e) => {
      const cn = e.data.invoice;
      if (cn?.kind !== 'credit_note' || !cn.ref_id) return;
      const inv = invoiceOf(e.locationId, cn.ref_id);
      if (inv && !unpaid(inv) && inv.status !== 'paid') withdraw(e.locationId, inv, 'Rechnung ist gutgeschrieben');
      else if (inv && unpaid(inv) && openCents(inv) <= 0) withdraw(e.locationId, inv, 'nichts mehr offen');
    });

    // --- API ------------------------------------------------------------------------------------------------------------------------
    const noticeOut = (n: any) => ({ ...n, channels: JSON.parse(n.channels || '[]'), edited: !!n.edited, pdf_url: `${app.baseUrl()}/mahnung/${n.token}/pdf`, token: undefined });
    router.get('/api/dunning/notices', 'location', (ctx) => {
      const where = ['n.location_id = ?'];
      const args: any[] = [ctx.locationId];
      for (const [k, col] of [['status', 'n.status'], ['invoice_id', 'n.invoice_id']] as const) {
        const v = ctx.query.get(k);
        if (v) (where.push(`${col} = ?`), args.push(v));
      }
      return db
        .all<any>(
          `SELECT n.*, i.number AS invoice_number, c.first_name, c.last_name, c.email, c.company FROM dunning_notices n JOIN invoices i ON i.id = n.invoice_id LEFT JOIN contacts c ON c.id = n.contact_id
           WHERE ${where.join(' AND ')} ORDER BY n.created_at DESC LIMIT ?`,
          ...args,
          clampLimit(ctx.query.get('limit'), 100, 500),
        )
        .map((n) => ({ ...noticeOut(n), contact: { id: n.contact_id, name: [n.first_name, n.last_name].filter(Boolean).join(' ') || n.email || '', company: n.company ?? '' }, first_name: undefined, last_name: undefined, email: undefined, company: undefined }));
    });
    const mustNotice = (ctx: Ctx) => {
      const n = db.get<Notice>('SELECT * FROM dunning_notices WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!n) throw notFound('Mahnung nicht gefunden');
      return n;
    };
    router.patch('/api/dunning/notices/:id', 'location', (ctx) => {
      const n = mustNotice(ctx);
      if (n.status !== 'pending') throw bad('Nur Entwürfe lassen sich ändern');
      const subject = clip(ctx.body?.subject, 300) || n.subject;
      const body = String(ctx.body?.body ?? n.body).slice(0, 10_000);
      db.run('UPDATE dunning_notices SET subject = ?, body = ?, edited = 1 WHERE id = ?', subject, body, n.id);
      return noticeOut(db.get('SELECT * FROM dunning_notices WHERE id = ?', n.id));
    });
    router.post('/api/dunning/notices/:id/send', 'location', async (ctx) => {
      const n = mustNotice(ctx);
      if (n.status !== 'pending' && n.status !== 'failed') throw bad('Diese Mahnung wurde schon bearbeitet');
      const r = await send(n, ctx.user?.name ?? 'API');
      if (r.status === 'canceled' || r.status === 'failed') throw bad(`Nicht gesendet: ${r.error}`);
      return noticeOut(r);
    });
    router.post('/api/dunning/notices/:id/resend', 'location', async (ctx) => {
      const n = mustNotice(ctx);
      if (n.status !== 'sent') throw bad('Nur gesendete Mahnungen lassen sich erneut senden');
      db.run(`UPDATE dunning_notices SET status = 'pending' WHERE id = ?`, n.id);
      const r = await send({ ...n, status: 'pending' }, ctx.user?.name ?? 'API');
      if (r.status !== 'sent') throw bad(`Nicht gesendet: ${r.error}`);
      return noticeOut(r);
    });
    router.post('/api/dunning/notices/:id/dismiss', 'location', (ctx) => {
      const n = mustNotice(ctx);
      if (n.status !== 'pending' && n.status !== 'failed') throw bad('Diese Mahnung wurde schon bearbeitet');
      db.run(`UPDATE dunning_notices SET status = 'dismissed', decided_by = ? WHERE id = ?`, ctx.user?.name ?? 'API', n.id);
      return noticeOut(db.get('SELECT * FROM dunning_notices WHERE id = ?', n.id));
    });
    router.get('/api/dunning/notices/:id/pdf', 'location', (ctx): RawResult => {
      const n = mustNotice(ctx);
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${n.level_key}-${n.invoice_id.slice(0, 6)}.pdf"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }, body: pdfOf(n) };
    });
    router.post('/api/dunning/run', 'location', async (ctx) => {
      const invoiceId = clip(ctx.body?.invoice_id, 40) || undefined;
      if (invoiceId && !invoiceOf(ctx.locationId, invoiceId)) throw notFound('Rechnung nicht gefunden');
      return run(ctx.locationId, { dry: !!ctx.body?.dry_run, invoiceId, force: !!invoiceId, by: ctx.user?.name ?? (ctx.viaApiKey ? 'API' : 'MCP') });
    });
    router.get('/api/dunning/preview', 'location', (ctx) => {
      const inv = invoiceOf(ctx.locationId, String(ctx.query.get('invoice_id') ?? ''));
      if (!inv) throw notFound('Rechnung nicht gefunden');
      const s = settings(ctx.locationId).inv;
      const contact = inv.contact_id ? getContact(app, ctx.locationId, inv.contact_id) : undefined;
      const lv = Math.min(s.levels.length, Math.max(1, Math.round(Number(ctx.query.get('level')) || 1))) - 1;
      const { level, a, deadline } = compose(inv, contact, s, lv);
      return { level: lv + 1, label: level.label, amounts: a, deadline_at: deadline.toISOString(), business: a.business };
    });
    router.get('/api/dunning/invoices', 'location', (ctx) => {
      const s = settings(ctx.locationId).inv;
      const rows = db.all<any>(
        `SELECT i.*, c.first_name, c.last_name, c.email, c.company FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
         WHERE i.location_id = ? AND i.kind = 'invoice' AND i.status = 'sent' AND i.total_cents - i.paid_cents - i.credited_cents - i.deducted_cents > 0 AND i.due_at IS NOT NULL AND i.due_at < ? ORDER BY i.due_at LIMIT 200`,
        ctx.locationId,
        // overdue from the day after the due date (the due day itself is still in time)
        overdueBefore(tzOf(ctx.locationId)),
      );
      return rows.map((inv) => {
        const last = lastNotice(inv.id);
        const nextIdx = Math.min(last?.level ?? 0, s.levels.length - 1);
        const a = noticeAmounts(s, nextIdx, { principal_cents: openCents(inv), due_at: inv.due_at, company: inv.company, tz: tzOf(ctx.locationId), prior_fee_cents: priorFees(inv.id, nextIdx + 1) });
        return {
          id: inv.id, number: inv.number, title: inv.title, total_cents: inv.total_cents, currency: inv.currency, due_at: inv.due_at, days_overdue: daysOverdue(inv.due_at, new Date(), tzOf(ctx.locationId)), url: `${app.baseUrl()}/i/${inv.public_token}`,
          contact: { id: inv.contact_id, name: [inv.first_name, inv.last_name].filter(Boolean).join(' ') || inv.email || '', company: inv.company ?? '' },
          level: last?.level ?? 0, level_label: last ? last.label : 'noch keine', last_status: last?.status ?? null, last_sent_at: last?.sent_at ?? null,
          next_label: (last?.level ?? 0) >= s.levels.length ? null : s.levels[nextIdx].label, next_total_cents: a.total_cents, held: !!holdOf(inv.id),
        };
      });
    });
    /** The team writes the next notice for one invoice now: sent at once or put in the approval list. */
    router.post('/api/dunning/invoices/:id/notice', 'location', async (ctx) => {
      const inv = invoiceOf(ctx.locationId, ctx.params.id);
      if (!inv) throw notFound('Rechnung nicht gefunden');
      if (!unpaid(inv)) throw bad('Die Rechnung ist nicht offen');
      if (holdOf(inv.id)) throw bad('Für diese Rechnung gilt ein Mahnstopp');
      if (!inv.contact_id) throw bad('Die Rechnung hat keinen Kontakt');
      const last = lastNotice(inv.id);
      if (last?.status === 'pending') throw bad('Eine Mahnung zu dieser Rechnung wartet schon auf Freigabe');
      if ((last?.level ?? 0) >= settings(ctx.locationId).inv.levels.length) throw bad('Alle Mahnstufen sind schon durch');
      const r = await run(ctx.locationId, { invoiceId: inv.id, force: true, send: ctx.body?.send === false ? 'draft' : 'now', by: ctx.user?.name ?? 'API' });
      if (!r.created.length) throw bad('Es ist noch keine Mahnung nötig');
      return r;
    });
    router.post('/api/dunning/invoices/:id/hold', 'location', (ctx) => {
      const inv = invoiceOf(ctx.locationId, ctx.params.id);
      if (!inv) throw notFound('Rechnung nicht gefunden');
      const on = ctx.body?.on !== false;
      db.run('DELETE FROM dunning_holds WHERE invoice_id = ?', inv.id);
      if (on) db.insert('dunning_holds', { invoice_id: inv.id, location_id: ctx.locationId, reason: clip(ctx.body?.reason, 200), created_at: now(), user_id: ctx.user?.id ?? null });
      auditLog(app, ctx, ctx.locationId, 'dunning.hold', `Mahnstopp ${on ? 'gesetzt' : 'aufgehoben'} (${inv.number})${ctx.body?.reason ? `: ${clip(ctx.body.reason, 100)}` : ''}`, inv.id);
      return { ok: true, held: on };
    });

    // --- public PDF (unguessable link from the e-mail) ---------------------------------------------------------------------------------
    router.get('/mahnung/:token/pdf', 'public', (ctx): RawResult => {
      if (PDF_LIMIT(ctx.ip)) throw notFound();
      const n = /^[A-Za-z0-9_-]{20,40}$/.test(ctx.params.token) ? db.get<Notice>(`SELECT * FROM dunning_notices WHERE token = ? AND status = 'sent'`, ctx.params.token) : undefined;
      if (!n) throw notFound();
      return { __raw: true, status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${n.level_key}.pdf"`, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' }, body: pdfOf(n) };
    });

    // --- workflows -------------------------------------------------------------------------------------------------------------------------
    registerTriggers(app, [
      {
        type: 'invoice.dunning_sent',
        label: 'Mahnung zu Rechnung versendet',
        category: 'payments',
        summary: 'Eine Zahlungserinnerung oder Mahnung zu einer überfälligen Rechnung wurde verschickt.',
        doc: 'Filter: Mahnstufe (Name). {{event.label}}, {{event.level}}, {{event.total_cents}} (Forderung inkl. Gebühren und Zinsen), {{event.deadline_at}} und {{event.invoice.number}} stehen bereit – z. B. für eine Aufgabe „Anrufen“ nach der 2. Mahnung.',
        fields: [{ key: 'level_key', label: 'Nur Mahnstufe (Schlüssel, z. B. dunning2)', type: 'text' }],
        sample: { invoice: { id: 'i1', number: 'RE-1001', total_cents: 11900, currency: 'EUR' }, level: 2, level_key: 'dunning1', label: '1. Mahnung', prior_fee_cents: 0, fee_cents: 500, interest_cents: 0, total_cents: 12400 },
        keywords: 'mahnung zahlungserinnerung rechnung überfällig mahnstufe verzug',
      },
    ]);
    app.services.workflowTriggerFilters = { ...(app.services.workflowTriggerFilters ?? {}), 'invoice.dunning_sent': (c: any, d: any) => !c.level_key || c.level_key === d.level_key };
    registerActions(app, [
      {
        meta: {
          type: 'invoice_dunning_send',
          label: 'Mahnung zur Rechnung senden',
          category: 'payments',
          icon: 'invoice',
          summary: 'Legt die nächste Mahnstufe für eine überfällige Rechnung an und sendet sie – oder legt sie zur Freigabe ab.',
          doc: 'Die Rechnung kommt aus dem Ereignis ({{event.invoice.id}}) oder dem Feld „Rechnung“. Es gilt die nächste Stufe nach den Einstellungen unter Mahnwesen (Gebühren, Zinsen, Fristen). Ist die Rechnung bezahlt oder auf Mahnstopp, passiert nichts.',
          fields: [
            { key: 'invoice_id', label: 'Rechnung (ID, leer = aus dem Ereignis)', type: 'text', placeholder: '{{event.invoice.id}}' },
            { key: 'mode', label: 'Was tun?', type: 'select', options: [['send', 'Sofort senden'], ['draft', 'Zur Freigabe ablegen']], default: 'send' },
          ],
          provides: ['var.dunning_level'],
          sample: { mode: 'draft' },
        },
        run: async (run, step, vars) => {
          const invoiceId = fill(step.invoice_id || '{{event.invoice.id}}', vars).trim();
          if (!invoiceId) throw new Error('Keine Rechnung im Ereignis – bitte „Rechnung“ ausfüllen');
          const inv = invoiceOf(run.location_id, invoiceId);
          if (!inv) throw new Error('Rechnung nicht gefunden');
          if (!unpaid(inv)) return `Rechnung ${inv.number} ist nicht offen – keine Mahnung`;
          if (holdOf(inv.id)) return `Mahnstopp bei ${inv.number}`;
          const last = lastNotice(inv.id);
          const s = settings(run.location_id).inv;
          if ((last?.level ?? 0) >= s.levels.length) return `Alle Mahnstufen für ${inv.number} sind schon durch`;
          if (last?.status === 'pending') return `Eine Mahnung zu ${inv.number} wartet schon auf Freigabe`;
          const n = create(run.location_id, inv, last?.level ?? 0, 'workflow');
          auditLog(app, undefined, run.location_id, 'dunning.notice_created', `${n.label} zu ${inv.number} angelegt (Workflow)`, n.id, 'Workflow');
          if (step.mode === 'draft') return { result: `${n.label} zur Freigabe abgelegt`, vars: { dunning_level: n.level } };
          const r = await send(n, 'Workflow');
          if (r.status !== 'sent') throw new Error(r.error || 'Nicht gesendet');
          return { result: `${r.label} gesendet`, vars: { dunning_level: r.level } };
        },
      },
    ]);

    app.services.dunningInvoices = { run, candidates, create, send, noticeAmounts };
  },
};
