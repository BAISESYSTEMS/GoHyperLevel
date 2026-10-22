import type { LocationRow, Module } from '../core/app.js';
import { bad, html, notFound, num, redirect, str, text, type Ctx, type RawResult } from '../core/http.js';
import { escapeHtml } from '../core/template.js';
import { addDaysYmd } from '../core/time.js';
import { centsToMoney, id, normalizeEmail, now, sha256, slugify, token } from '../core/util.js';
import { cleanRef, type AttributionHook, type TouchRow } from '../services/attribution.js';
import { today } from '../services/bo-common.js';
import { cleanIban, commissionFor, payoutCsv, refundAdjustment, sepaXml, validIban, type PayoutLine } from '../services/affiliates.js';
import { getContact, logActivity, upsertContact } from '../services/contacts.js';
import { deliverEmail, type OutMail } from '../services/messaging.js';
import type { Tool } from './mcp.js';

/**
 * Affiliate manager (like GHL's): programs per sub-account (percent or fixed commission, first
 * or last click, cookie lifetime, recurring commission, payout threshold), affiliates via a public
 * sign-up form or added by hand, links with ?ref=<code>, and a small portal with magic-link login.
 * Clicks come from the attribution module (app.services.attributionHooks); commissions from
 * invoice.paid / product.purchased, reversed on payment.refunded or a voided invoice.
 * Approval: pending → approved → paid (payout export as CSV or SEPA XML).
 */

const LINK_TTL_MS = 30 * 60_000;
const SESSION_DAYS = 30;
const CLICK_DEDUPE_MS = 24 * 3600_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HEX = /^#[0-9a-f]{6}$/i;
export const AFFILIATE_TRIGGERS = ['affiliate.created', 'affiliate.commission_created'];

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_affiliates',
    title: 'Affiliates auflisten',
    description: 'Affiliates eines Projekts mit Programm, Status, Code/Link und Zahlen: Klicks, Leads, Verkäufe, Umsatz, Provision offen/freigegeben/ausgezahlt. Filter: program_id, status (pending|active|blocked).',
    inputSchema: {
      type: 'object',
      properties: { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' }, program_id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'active', 'blocked'] } },
      required: ['location_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (call, a) => {
      const qs = new URLSearchParams();
      if (a.program_id) qs.set('program_id', String(a.program_id));
      if (a.status) qs.set('status', String(a.status));
      const list: any[] = await call.api('GET', `/api/affiliates?${qs}`, { location: a.location_id });
      return list.map(({ iban: _i, bic: _b, paypal_email: _p, login_ip_hash: _l, ...rest }) => rest);
    },
  },
];

const PORTAL_CSS = `
:root { --text:#0f172a; --muted:#64748b; --line:#e2e8f0; --bg:#f6f7fb; --panel:#fff; --ok:#059669; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --text:#e5e7eb; --muted:#94a3b8; --line:#1e293b; --bg:#0b1020; --panel:#111a2e; color-scheme: dark; } }
* { box-sizing: border-box; } body { margin: 0; font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); background: var(--bg); }
a { color: var(--brand); } .top { background: var(--panel); border-bottom: 1px solid var(--line); }
.top .in { max-width: 1040px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; gap: 12px; }
.brand { font-weight: 700; display: flex; gap: 10px; align-items: center; } .brand img { max-height: 34px; } .brand .mark { width: 32px; height: 32px; border-radius: 9px; background: var(--brand); color: #fff; display: grid; place-items: center; }
.who { margin-left: auto; display: flex; gap: 12px; align-items: center; color: var(--muted); font-size: 14px; } .who form { margin: 0; }
.linkbtn { background: none; border: 0; color: var(--brand); font: inherit; cursor: pointer; padding: 0; }
main { max-width: 1040px; margin: 0 auto; padding: 26px 20px 60px; } h1 { font-size: clamp(24px, 3.2vw, 32px); margin: 0 0 6px; } h2 { font-size: 19px; margin: 0 0 10px; }
.muted { color: var(--muted); } .small { font-size: 14px; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px; margin-bottom: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin-bottom: 16px; }
.tile { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; } .tile b { display: block; font-size: 24px; margin-top: 2px; }
.btn { display: inline-flex; align-items: center; justify-content: center; background: var(--brand); color: #fff; border: 0; border-radius: 10px; padding: 11px 18px; font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; }
.btn.wide { width: 100%; } .btn.ghost { background: var(--panel); color: var(--text); border: 1px solid var(--line); }
label { display: block; font-weight: 600; font-size: 14px; margin: 12px 0 6px; } .check { display: flex; gap: 8px; font-weight: 400; align-items: flex-start; } .check input { width: auto; margin-top: 5px; }
input, select { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 10px; font: inherit; background: var(--panel); color: var(--text); }
.copy { font-family: ui-monospace, monospace; font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 15px; } th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); } th { color: var(--muted); font-weight: 600; font-size: 13px; }
.pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 99px; background: var(--soft); color: var(--brand); } .pill.ok { background: rgba(5,150,105,.14); color: var(--ok); } .pill.off { background: rgba(100,116,139,.16); color: var(--muted); }
.auth { min-height: calc(100vh - 140px); display: grid; place-items: center; } .auth .panel { width: 100%; max-width: 440px; padding: 30px; }
.err { color: #dc2626; font-size: 14px; } .notice { background: rgba(5,150,105,.12); color: var(--ok); padding: 12px 16px; border-radius: 12px; margin-bottom: 16px; font-weight: 600; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
.scroll { overflow-x: auto; }
`;

const STATUS_DE: Record<string, string> = { pending: 'offen', approved: 'freigegeben', paid: 'ausgezahlt', reversed: 'storniert', open: 'offen' };

export const affiliatesModule: Module = {
  name: 'affiliates',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE affiliate_programs (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1,
        commission_type TEXT NOT NULL DEFAULT 'percent', commission_value REAL NOT NULL DEFAULT 20,
        attribution TEXT NOT NULL DEFAULT 'last', cookie_days INTEGER NOT NULL DEFAULT 30,
        recurring INTEGER NOT NULL DEFAULT 0, payout_threshold_cents INTEGER NOT NULL DEFAULT 5000, hold_days INTEGER NOT NULL DEFAULT 0,
        landing_url TEXT NOT NULL DEFAULT '', public_signup INTEGER NOT NULL DEFAULT 1, auto_approve INTEGER NOT NULL DEFAULT 0,
        terms TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE affiliates (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        program_id TEXT NOT NULL REFERENCES affiliate_programs(id) ON DELETE CASCADE, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        payout_method TEXT NOT NULL DEFAULT 'sepa', iban TEXT NOT NULL DEFAULT '', bic TEXT NOT NULL DEFAULT '', paypal_email TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', login_ip_hash TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, code), UNIQUE(program_id, email)
      );
      CREATE TABLE affiliate_clicks (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE, visitor_id TEXT NOT NULL DEFAULT '', ip_hash TEXT NOT NULL DEFAULT '',
        landing TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', counted INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE INDEX affiliate_clicks_aff ON affiliate_clicks(affiliate_id, created_at);
      CREATE TABLE affiliate_referrals (
        location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE, program_id TEXT NOT NULL, touch_at TEXT, created_at TEXT NOT NULL,
        PRIMARY KEY (location_id, contact_id)
      );
      CREATE TABLE affiliate_commissions (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, program_id TEXT NOT NULL,
        affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE, contact_id TEXT, invoice_id TEXT,
        kind TEXT NOT NULL DEFAULT 'sale', base_cents INTEGER NOT NULL DEFAULT 0, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
        original_cents INTEGER, status TEXT NOT NULL DEFAULT 'pending', note TEXT NOT NULL DEFAULT '', reversal_of TEXT, payout_id TEXT,
        created_at TEXT NOT NULL, approved_at TEXT, paid_at TEXT, reversed_at TEXT
      );
      CREATE UNIQUE INDEX affiliate_commissions_sale ON affiliate_commissions(program_id, invoice_id) WHERE kind != 'clawback';
      CREATE UNIQUE INDEX affiliate_commissions_clawback ON affiliate_commissions(reversal_of) WHERE reversal_of IS NOT NULL;
      CREATE INDEX affiliate_commissions_aff ON affiliate_commissions(affiliate_id, status);
      CREATE TABLE affiliate_payouts (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'EUR',
        method TEXT NOT NULL DEFAULT 'sepa', reference TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, paid_at TEXT
      );
      CREATE TABLE affiliate_login_tokens (
        token_hash TEXT PRIMARY KEY, affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE affiliate_sessions (
        token_hash TEXT PRIMARY KEY, affiliate_id TEXT NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    app.services.workflowTriggers = [...(app.services.workflowTriggers ?? []), ...AFFILIATE_TRIGGERS];
    const mailer = (loc: LocationRow, mail: OutMail): Promise<{ status: string }> => (app.services.affiliateMailer ?? deliverEmail)(loc, mail);
    const ipHash = (ip: string) => (ip ? sha256(`${app.config.secret}:ip:${ip}`).slice(0, 32) : '');
    const money = (c: number, cur = 'EUR') => centsToMoney(c, cur);

    const program = (pid: string, locationId?: string) => db.get(`SELECT * FROM affiliate_programs WHERE id = ?${locationId ? ' AND location_id = ?' : ''}`, pid, ...(locationId ? [locationId] : []));
    const affiliate = (aid: string, locationId?: string) => db.get(`SELECT * FROM affiliates WHERE id = ?${locationId ? ' AND location_id = ?' : ''}`, aid, ...(locationId ? [locationId] : []));
    const portalUrl = (p: any) => `${app.baseUrl()}/affiliate/${encodeURIComponent(p.slug)}`;
    const linkFor = (p: any, a: any) => {
      const f = db.get('SELECT slug FROM funnels WHERE location_id = ? ORDER BY created_at LIMIT 1', p.location_id);
      const base = p.landing_url || (f ? `${app.baseUrl()}/p/${f.slug}` : app.baseUrl());
      return `${base}${base.includes('?') ? '&' : '?'}ref=${encodeURIComponent(a.code)}`;
    };
    const uniqueCode = (locationId: string, wanted: string) => {
      const base = cleanRef(wanted).replace(/[-_]/g, '').slice(0, 14) || 'partner';
      let code = base.length >= 3 ? base : `${base}${id(4).toLowerCase()}`;
      while (db.get('SELECT id FROM affiliates WHERE location_id = ? AND code = ?', locationId, code)) code = `${base}${Math.floor(100 + Math.random() * 900)}`;
      return code;
    };

    // --- creating affiliates (admin or public sign-up) --------------------------------------------
    function createAffiliate(p: any, input: Record<string, any>, source: 'manual' | 'signup') {
      const email = normalizeEmail(input.email);
      if (!EMAIL_RE.test(email) || email.length > 200) throw bad('Bitte eine gültige E-Mail-Adresse angeben');
      if (db.get('SELECT id FROM affiliates WHERE program_id = ? AND email = ?', p.id, email)) throw bad('Diese E-Mail ist in diesem Programm schon angemeldet');
      const name = str(input.name, 'Name', { max: 120 });
      let code = input.code ? cleanRef(input.code) : '';
      if (code && code.length < 3) throw bad('Code: mindestens 3 Zeichen (a–z, 0–9, - und _)');
      if (code && db.get('SELECT id FROM affiliates WHERE location_id = ? AND code = ?', p.location_id, code)) throw bad('Code schon vergeben');
      code ||= uniqueCode(p.location_id, name || email.split('@')[0]);
      const iban = cleanIban(input.iban);
      if (iban && !validIban(iban)) throw bad('IBAN ist ungültig');
      const { contact } = upsertContact(app, p.location_id, { name, email }, { source: 'Affiliate-Programm', tags: ['affiliate'] });
      const status = source === 'manual' ? (['pending', 'active', 'blocked'].includes(input.status) ? input.status : 'active') : p.auto_approve ? 'active' : 'pending';
      const row = {
        id: id(),
        location_id: p.location_id,
        program_id: p.id,
        contact_id: contact.id,
        name: name || [contact.first_name, contact.last_name].filter(Boolean).join(' '),
        email,
        code,
        status,
        payout_method: input.payout_method === 'paypal' ? 'paypal' : 'sepa',
        iban,
        bic: str(input.bic, 'BIC', { max: 11 }).toUpperCase(),
        paypal_email: normalizeEmail(input.paypal_email),
        notes: str(input.notes, 'Notiz', { max: 2000 }),
        source,
        created_at: now(),
        updated_at: now(),
      };
      db.insert('affiliates', row);
      logActivity(app, p.location_id, contact.id, 'affiliate.created', `Affiliate im Programm „${p.name}“ (Code ${code}, ${status === 'active' ? 'aktiv' : 'wartet auf Freigabe'})`);
      app.events.emit(p.location_id, 'affiliate.created', { contactId: contact.id, affiliateId: row.id, programId: p.id, affiliate: { name: row.name, email, code, status, link: linkFor(p, row), portal: portalUrl(p) } });
      return row;
    }

    // --- clicks (from attribution visits) and referrals (leads) ------------------------------------
    const activeByCode = (locationId: string, code: string) =>
      code ? db.get(`SELECT a.*, p.cookie_days, p.attribution FROM affiliates a JOIN affiliate_programs p ON p.id = a.program_id WHERE a.location_id = ? AND a.code = ? AND a.status = 'active' AND p.active = 1`, locationId, code) : undefined;

    const hook: AttributionHook = {
      onTouch: ({ locationId, visitorId, touch, ip }) => {
        const a = activeByCode(locationId, touch.ref);
        if (!a) return;
        const h = ipHash(ip);
        const since = new Date(Date.now() - CLICK_DEDUPE_MS).toISOString();
        const self = !!h && h === a.login_ip_hash;
        const dup = db.get('SELECT id FROM affiliate_clicks WHERE affiliate_id = ? AND counted = 1 AND created_at > ? AND (visitor_id = ? OR (ip_hash != \'\' AND ip_hash = ?)) LIMIT 1', a.id, since, visitorId, h);
        db.insert('affiliate_clicks', { id: id(), location_id: locationId, affiliate_id: a.id, visitor_id: visitorId, ip_hash: h, landing: touch.landing_page, referrer: touch.referrer, counted: self || dup ? 0 : 1, reason: self ? 'self' : dup ? 'duplicate' : '', created_at: now() });
      },
      onLink: ({ locationId, contactId }) => referFromTouches(locationId, contactId),
    };
    app.services.attributionHooks = [...(app.services.attributionHooks ?? []), hook];

    // Other modules (community: partner links for members) sign people up and read their numbers.
    app.services.affiliateKit = {
      programOf: (pid: string, locationId: string) => program(pid, locationId),
      forContact: (programId: string, contactId: string) => db.get('SELECT * FROM affiliates WHERE program_id = ? AND contact_id = ?', programId, contactId),
      signUp: (p: any, input: { name: string; email: string }) => createAffiliate(p, input, 'signup'),
      linkOf: (p: any, a: any) => linkFor(p, a),
      statsOf: (affiliateId: string) => withStats('a.id = ?', affiliateId)[0],
      portalUrl: (p: any) => portalUrl(p),
    };

    /** Picks the referring affiliate from the contact's visits (first or last click within the cookie lifetime). */
    function referFromTouches(locationId: string, contactId: string) {
      if (db.get('SELECT 1 FROM affiliate_referrals WHERE location_id = ? AND contact_id = ?', locationId, contactId)) return;
      const touches: TouchRow[] = (app.services.attribution?.touchesOf(locationId, contactId) ?? []).filter((t: TouchRow) => t.ref);
      const contact = getContact(app, locationId, contactId);
      const candidates = touches
        .map((t) => ({ t, a: activeByCode(locationId, t.ref) as any }))
        .filter((x) => x.a && Date.now() - Date.parse(x.t.created_at) <= Number(x.a.cookie_days) * 864e5)
        .filter((x) => {
          const self = x.a.contact_id === contactId || (!!contact?.email && contact.email === x.a.email);
          if (self) logActivity(app, locationId, contactId, 'affiliate.self_referral', `Eigenempfehlung von Affiliate ${x.a.code} nicht gezählt`);
          return !self;
        });
      if (!candidates.length) return;
      const latest = candidates[candidates.length - 1];
      const pick = latest.a.attribution === 'first' ? candidates[0] : latest;
      if (!db.run('INSERT OR IGNORE INTO affiliate_referrals (location_id, contact_id, affiliate_id, program_id, touch_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', locationId, contactId, pick.a.id, pick.a.program_id, pick.t.created_at, now()).changes) return;
      logActivity(app, locationId, contactId, 'affiliate.referred', `Geworben von Affiliate ${pick.a.name || pick.a.code} (${pick.a.code})`);
      // A purchase that paid a moment before the visit was linked (event order) still counts.
      for (const inv of db.all("SELECT id FROM invoices WHERE location_id = ? AND contact_id = ? AND status = 'paid' AND paid_at > ?", locationId, contactId, new Date(Date.now() - 10 * 60_000).toISOString())) commissionForInvoice(locationId, inv.id);
    }

    // --- commissions -------------------------------------------------------------------------------
    /** The net a sale earns commission on: a final invoice without the partial invoices it deducts (they earned their own when paid). */
    function commissionBase(inv: any): number {
      let deducted = 0;
      try {
        const snap = typeof inv.snapshot === 'string' ? JSON.parse(inv.snapshot) : inv.snapshot;
        for (const d of Array.isArray(snap?.deductions) ? snap.deductions : []) deducted += Number(d?.net_cents) || 0;
      } catch {
        /* no snapshot: nothing deducted */
      }
      return Math.max(0, Number(inv.subtotal_cents) - deducted);
    }
    /** Net of the finalised credit notes (Gutschriften, not the Storno) written against an invoice so far. */
    const creditedNet = (locationId: string, invoiceId: string): number =>
      Number(
        db.get(
          `SELECT COALESCE(SUM(-subtotal_cents), 0) AS n FROM invoices WHERE location_id = ? AND ref_id = ? AND kind = 'credit_note' AND credit_type = 'credit' AND finalised_at IS NOT NULL`,
          locationId,
          invoiceId,
        )?.n ?? 0,
      );
    function commissionForInvoice(locationId: string, invoiceId: string, opts: { recurring?: boolean } = {}) {
      const inv = db.get('SELECT * FROM invoices WHERE id = ? AND location_id = ?', invoiceId, locationId);
      if (!inv?.contact_id || inv.kind !== 'invoice' || inv.status !== 'paid') return;
      const ref = db.get('SELECT * FROM affiliate_referrals WHERE location_id = ? AND contact_id = ?', locationId, inv.contact_id);
      if (!ref) return;
      const a = affiliate(ref.affiliate_id);
      const p = a && program(a.program_id);
      if (!a || !p || a.status !== 'active' || !p.active) return;
      if (a.contact_id === inv.contact_id) return;
      const recurring = !!opts.recurring || !!inv.parent_id;
      // what was credited before the payment (Gutschrift) earns nothing
      const base = Math.max(0, commissionBase(inv) - creditedNet(locationId, inv.id));
      const amount = commissionFor(p as any, { base_cents: base, recurring });
      if (!amount) return;
      const c = { id: id(), location_id: locationId, program_id: p.id, affiliate_id: a.id, contact_id: inv.contact_id, invoice_id: inv.id, kind: recurring ? 'recurring' : 'sale', base_cents: base, amount_cents: amount, currency: inv.currency, status: 'pending', note: `Rechnung ${inv.number}${inv.title ? ` – ${inv.title}` : ''}`.slice(0, 300), created_at: now() };
      if (!db.run(
        `INSERT OR IGNORE INTO affiliate_commissions (id, location_id, program_id, affiliate_id, contact_id, invoice_id, kind, base_cents, amount_cents, original_cents, currency, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id, c.location_id, c.program_id, c.affiliate_id, c.contact_id, c.invoice_id, c.kind, c.base_cents, c.amount_cents, c.amount_cents, c.currency, c.status, c.note, c.created_at,
      ).changes)
        return;
      if (a.contact_id) logActivity(app, locationId, a.contact_id, 'affiliate.commission_created', `Provision ${money(amount, c.currency)} für ${c.note}`);
      app.events.emit(locationId, 'affiliate.commission_created', { contactId: a.contact_id, affiliateId: a.id, programId: p.id, commissionId: c.id, amount_cents: amount, currency: c.currency, kind: c.kind, customerId: inv.contact_id, invoiceId: inv.id });
    }
    app.events.on('invoice.paid', (e) => {
      if (e.data.invoice?.id) commissionForInvoice(e.locationId, e.data.invoice.id, { recurring: e.data.via === 'Stripe-Abo' });
    });
    // Buy-link purchases: the buyer may only now be linked to the affiliate's visit.
    app.events.on('product.purchased', (e) => {
      if (e.data.contactId) referFromTouches(e.locationId, e.data.contactId);
      if (e.data.invoiceId) commissionForInvoice(e.locationId, e.data.invoiceId);
    });

    /**
     * Brings the clawbacks of a paid-out commission to `desired` (cumulative, ≤ 0). The open clawback (not yet in a payout) is
     * adjusted; once one went out with a payout, the rest is a new clawback – a payout's history is never edited. A clawback
     * reversed by hand is the team's decision and stays.
     */
    const clawbacksOf = (c: any) => db.all<any>(`SELECT * FROM affiliate_commissions WHERE kind = 'clawback' AND (reversal_of = ? OR (reversal_of IS NULL AND program_id = ? AND invoice_id = ?))`, c.id, c.program_id, c.invoice_id);
    function clawback(c: any, desired: number, why: string) {
      const rows = clawbacksOf(c);
      if (rows.some((r) => r.status === 'reversed')) return;
      const open = rows.find((r) => r.status !== 'paid' && !r.payout_id);
      const settled = rows.filter((r) => r !== open).reduce((n, r) => n + Number(r.amount_cents), 0);
      const want = desired - settled;
      if (open) {
        if (want < open.amount_cents) db.run('UPDATE affiliate_commissions SET amount_cents = ? WHERE id = ?', want, open.id);
        return;
      }
      if (want >= 0) return;
      // the first clawback points at its commission (reversal_of, unique); later ones carry the invoice
      db.run(
        `INSERT INTO affiliate_commissions (id, location_id, program_id, affiliate_id, contact_id, invoice_id, kind, base_cents, amount_cents, currency, status, note, reversal_of, created_at, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'clawback', 0, ?, ?, 'approved', ?, ?, ?, ?)`,
        id(), c.location_id, c.program_id, c.affiliate_id, c.contact_id, rows.length ? c.invoice_id : null, want, c.currency, `Rückbuchung: ${c.note} (${why})`.slice(0, 300), rows.length ? null : c.id, now(), now(),
      );
    }

    /** Applies what a refund or credit note means for one commission (services/affiliates.ts refundAdjustment). */
    function adjust(c: any, refunded: number, total: number, why: string) {
      // once a clawback exists (the commission was paid out, or in a payout that was deleted later), corrections stay clawbacks
      const clawed = clawbacksOf(c).length > 0;
      const adj = refundAdjustment(clawed ? { ...c, payout_id: c.payout_id ?? 'clawed' } : c, refunded, total);
      if (adj.action === 'reverse') db.run(`UPDATE affiliate_commissions SET status = 'reversed', reversed_at = ?, note = ? WHERE id = ?`, now(), `${c.note} · storniert (${why})`.slice(0, 300), c.id);
      else if (adj.action === 'reduce') db.run('UPDATE affiliate_commissions SET amount_cents = ?, note = ? WHERE id = ?', adj.amount, `${c.note} · gekürzt (${why})`.slice(0, 300), c.id);
      else if (adj.action === 'clawback') clawback(c, adj.amount, why);
    }
    const commissionsOf = (locationId: string, invoiceId: string) => db.all<any>("SELECT * FROM affiliate_commissions WHERE location_id = ? AND invoice_id = ? AND kind != 'clawback'", locationId, invoiceId);

    /** A refund took back `refunded` of `total` (cumulative, as Stripe reports it): commissions of the invoice shrink, go or are clawed back. */
    function applyRefund(locationId: string, invoiceId: string, refunded: number, total: number, why: string) {
      for (const c of commissionsOf(locationId, invoiceId)) adjust(c, refunded, total, why);
    }
    /**
     * Credit notes (Gutschrift / Rechnungskorrektur) of an invoice: its commissions follow the net that is left. Each one was
     * earned on `base_cents`; what the credit notes took beyond what was known then (credited before the payment) is taken back.
     */
    function applyCredits(locationId: string, invoiceId: string, why: string) {
      const inv = db.get('SELECT * FROM invoices WHERE id = ? AND location_id = ?', invoiceId, locationId);
      if (!inv) return;
      const left = Math.max(0, commissionBase(inv) - creditedNet(locationId, invoiceId));
      for (const c of commissionsOf(locationId, invoiceId)) {
        const base = Number(c.base_cents) || 0;
        if (base > 0 && left < base) adjust(c, base - left, base, why);
      }
    }
    app.events.on('invoice.finalised', (e) => {
      const cn = e.data.invoice;
      if (cn?.kind === 'credit_note' && cn.credit_type === 'credit' && cn.ref_id) applyCredits(e.locationId, cn.ref_id, `Gutschrift ${cn.number}`);
    });
    // A Stornorechnung takes all of it back (the tick below is the fallback for invoices voided another way).
    app.events.on('invoice.cancelled', (e) => {
      const inv = e.data.invoice;
      if (inv?.id) applyRefund(e.locationId, inv.id, 1, 1, 'Rechnung storniert');
    });
    app.events.on('payment.refunded', (e) => {
      if (!e.data.invoiceId) return;
      const inv = db.get('SELECT total_cents FROM invoices WHERE id = ?', e.data.invoiceId);
      applyRefund(e.locationId, e.data.invoiceId, e.data.full ? (inv?.total_cents ?? 1) : Number(e.data.amount_cents ?? 0), inv?.total_cents ?? 0, 'Erstattung');
    });

    // Background: voided invoices reverse their commissions, holds expire, old logins go.
    let clicksScrubbed = 0;
    app.onTick(() => {
      for (const c of db.all(
        `SELECT c.location_id, c.invoice_id, i.total_cents FROM affiliate_commissions c JOIN invoices i ON i.id = c.invoice_id
         WHERE c.kind != 'clawback' AND i.status = 'void' AND c.status != 'reversed' AND NOT EXISTS (SELECT 1 FROM affiliate_commissions x WHERE x.reversal_of = c.id)`,
      ))
        applyRefund(c.location_id, c.invoice_id, c.total_cents || 1, c.total_cents || 1, 'Rechnung storniert');
      for (const p of db.all('SELECT id, hold_days FROM affiliate_programs WHERE hold_days > 0'))
        db.run(`UPDATE affiliate_commissions SET status = 'approved', approved_at = ? WHERE program_id = ? AND status = 'pending' AND created_at < ?`, now(), p.id, new Date(Date.now() - p.hold_days * 864e5).toISOString());
      db.run('DELETE FROM affiliate_login_tokens WHERE expires_at < ?', new Date(Date.now() - 864e5).toISOString());
      db.run('DELETE FROM affiliate_sessions WHERE expires_at < ?', now());
      // The visitor id and the hash of the address only tell a repeated click within 24 hours: after two days they go, the
      // click (landing page, referrer, counted) stays for the numbers. Leads are found through the attribution touches.
      if (Date.now() - clicksScrubbed > 3600_000) {
        clicksScrubbed = Date.now();
        db.run(`UPDATE affiliate_clicks SET visitor_id = '', ip_hash = '' WHERE created_at < ? AND (visitor_id != '' OR ip_hash != '')`, new Date(Date.now() - 2 * 864e5).toISOString());
      }
    });

    // --- stats ---------------------------------------------------------------------------------------
    const STATS = `
      (SELECT COUNT(*) FROM affiliate_clicks k WHERE k.affiliate_id = a.id AND k.counted = 1) AS clicks,
      (SELECT COUNT(*) FROM affiliate_referrals r WHERE r.affiliate_id = a.id) AS leads,
      (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.kind != 'clawback' AND c.status != 'reversed') AS sales,
      (SELECT COALESCE(SUM(c.base_cents), 0) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.kind != 'clawback' AND c.status != 'reversed') AS revenue_cents,
      (SELECT COALESCE(SUM(c.amount_cents), 0) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.status = 'pending') AS pending_cents,
      (SELECT COALESCE(SUM(c.amount_cents), 0) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.status = 'approved') AS approved_cents,
      (SELECT COALESCE(SUM(c.amount_cents), 0) FROM affiliate_commissions c WHERE c.affiliate_id = a.id AND c.status = 'paid') AS paid_cents`;
    const withStats = (where: string, ...params: any[]): any[] =>
      db
        .all(`SELECT a.*, p.name AS program_name, p.slug AS program_slug, p.landing_url, ${STATS} FROM affiliates a JOIN affiliate_programs p ON p.id = a.program_id WHERE ${where} ORDER BY a.created_at DESC`, ...params)
        .map((a) => ({ ...a, link: linkFor({ landing_url: a.landing_url, location_id: a.location_id }, a), portal_url: `${app.baseUrl()}/affiliate/${encodeURIComponent(a.program_slug)}` }));

    // --- admin API: programs ---------------------------------------------------------------------------
    const cleanProgram = (b: any, cur: any = {}) => {
      const out: Record<string, any> = {};
      if (b.name !== undefined || !cur.id) out.name = str(b.name, 'Name', { required: true, max: 120 });
      if (b.commission_type !== undefined) out.commission_type = b.commission_type === 'fixed' ? 'fixed' : 'percent';
      if (b.commission_value !== undefined) {
        const v = num(b.commission_value, -1);
        const type = out.commission_type ?? cur.commission_type ?? 'percent';
        if (v < 0 || (type === 'percent' && v > 100)) throw bad(type === 'percent' ? 'Provision: 0 bis 100 %' : 'Provision: Betrag in Cent ≥ 0');
        out.commission_value = type === 'fixed' ? Math.round(v) : v;
      }
      if (b.attribution !== undefined) out.attribution = b.attribution === 'first' ? 'first' : 'last';
      if (b.cookie_days !== undefined) out.cookie_days = Math.min(Math.max(Math.round(num(b.cookie_days, 30)), 1), 365);
      if (b.recurring !== undefined) out.recurring = b.recurring ? 1 : 0;
      if (b.payout_threshold_cents !== undefined) out.payout_threshold_cents = Math.max(0, Math.round(num(b.payout_threshold_cents, 0)));
      if (b.hold_days !== undefined) out.hold_days = Math.min(Math.max(Math.round(num(b.hold_days, 0)), 0), 365);
      if (b.landing_url !== undefined) {
        const u = str(b.landing_url, 'Ziel-Link', { max: 500 });
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw bad('Ziel-Link: bitte mit https:// angeben');
        out.landing_url = u;
      }
      for (const k of ['public_signup', 'auto_approve', 'active']) if (b[k] !== undefined) out[k] = b[k] ? 1 : 0;
      if (b.terms !== undefined) out.terms = str(b.terms, 'Bedingungen', { max: 5000 });
      return out;
    };
    const programOut = (p: any) => ({
      ...p,
      portal_url: portalUrl(p),
      signup_url: `${portalUrl(p)}/join`,
      affiliates: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM affiliates WHERE program_id = ?', p.id)!.n,
    });

    router.get('/api/affiliates/programs', 'location', (ctx) => db.all('SELECT * FROM affiliate_programs WHERE location_id = ? ORDER BY created_at', ctx.locationId).map(programOut));
    router.post('/api/affiliates/programs', 'location', (ctx) => {
      const fields = cleanProgram(ctx.body ?? {});
      let slug = slugify(ctx.body?.slug || fields.name);
      for (let i = 2; db.get('SELECT id FROM affiliate_programs WHERE slug = ?', slug); i++) slug = `${slugify(ctx.body?.slug || fields.name)}-${i}`;
      const row = { id: id(), location_id: ctx.locationId, slug, commission_type: 'percent', commission_value: 20, attribution: 'last', cookie_days: 30, recurring: 0, payout_threshold_cents: 5000, hold_days: 0, landing_url: '', public_signup: 1, auto_approve: 0, active: 1, terms: '', ...fields, created_at: now(), updated_at: now() };
      db.insert('affiliate_programs', row);
      return programOut(program(row.id));
    });
    router.patch('/api/affiliates/programs/:id', 'location', (ctx) => {
      const p = program(ctx.params.id, ctx.locationId);
      if (!p) throw notFound();
      const patch = cleanProgram(ctx.body ?? {}, p);
      if (ctx.body?.slug !== undefined) {
        const slug = slugify(String(ctx.body.slug));
        if (db.get('SELECT id FROM affiliate_programs WHERE slug = ? AND id != ?', slug, p.id)) throw bad('Adresse schon vergeben');
        patch.slug = slug;
      }
      db.update('affiliate_programs', p.id, { ...patch, updated_at: now() });
      return programOut(program(p.id));
    });
    router.delete('/api/affiliates/programs/:id', 'location', (ctx) => {
      db.run('DELETE FROM affiliate_programs WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });

    // --- admin API: commissions ------------------------------------------------------------------------
    router.get('/api/affiliates/commissions', 'location', (ctx) => {
      const where = ['c.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const st = ctx.query.get('status');
      if (st) (where.push('c.status = ?'), params.push(st));
      const aff = ctx.query.get('affiliate_id');
      if (aff) (where.push('c.affiliate_id = ?'), params.push(aff));
      return db.all(
        `SELECT c.*, a.name AS affiliate_name, a.code, k.first_name, k.last_name, k.email AS customer_email, i.number AS invoice_number
         FROM affiliate_commissions c JOIN affiliates a ON a.id = c.affiliate_id LEFT JOIN contacts k ON k.id = c.contact_id LEFT JOIN invoices i ON i.id = c.invoice_id
         WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 2000`,
        ...params,
      );
    });
    router.post('/api/affiliates/commissions', 'location', (ctx) => {
      const a = affiliate(String(ctx.body?.affiliate_id ?? ''), ctx.locationId);
      if (!a) throw bad('Affiliate wählen');
      const amount = Math.round(num(ctx.body?.amount_cents, 0));
      if (!amount) throw bad('Betrag fehlt');
      const row = { id: id(), location_id: ctx.locationId, program_id: a.program_id, affiliate_id: a.id, kind: 'manual', base_cents: 0, amount_cents: amount, currency: 'EUR', status: 'approved', note: str(ctx.body?.note, 'Notiz', { max: 300 }) || 'Manuelle Buchung', created_at: now(), approved_at: now() };
      db.insert('affiliate_commissions', row);
      return row;
    });
    router.post('/api/affiliates/commissions/approve', 'location', (ctx) => {
      const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String).slice(0, 2000) : [];
      let n = 0;
      for (const cid of ids) n += db.run(`UPDATE affiliate_commissions SET status = 'approved', approved_at = ? WHERE id = ? AND location_id = ? AND status = 'pending'`, now(), cid, ctx.locationId).changes;
      return { approved: n };
    });
    router.post('/api/affiliates/commissions/:id/reverse', 'location', (ctx) => {
      const c = db.get('SELECT * FROM affiliate_commissions WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!c) throw notFound();
      if (c.status === 'paid') throw bad('Schon ausgezahlt – bitte eine manuelle Gegenbuchung anlegen');
      if (c.payout_id) throw bad('Steckt in einer offenen Auszahlung – erst die Auszahlung löschen');
      db.run(`UPDATE affiliate_commissions SET status = 'reversed', reversed_at = ?, note = ? WHERE id = ?`, now(), `${c.note} · storniert${ctx.body?.note ? `: ${str(ctx.body.note, 'Grund', { max: 200 })}` : ''}`.slice(0, 300), c.id);
      return { ok: true };
    });

    // --- admin API: payouts ----------------------------------------------------------------------------
    const payoutLines = (locationId: string, ids: string[]): PayoutLine[] =>
      db
        .all(
          `SELECT o.*, a.name, a.email, a.iban, a.bic, a.paypal_email FROM affiliate_payouts o JOIN affiliates a ON a.id = o.affiliate_id
           WHERE o.location_id = ? ${ids.length ? `AND o.id IN (${ids.map(() => '?').join(',')})` : "AND o.status = 'open'"} ORDER BY o.created_at`,
          locationId,
          ...ids,
        )
        .map((o) => ({ id: o.id, name: o.name || o.email, email: o.email, iban: o.iban, bic: o.bic, paypal: o.paypal_email, method: o.method, amount_cents: o.amount_cents, currency: o.currency, reference: o.reference }));
    const idsOf = (ctx: Ctx) => String(ctx.query.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);

    router.get('/api/affiliates/payouts', 'location', (ctx) =>
      db.all(
        `SELECT o.*, a.name AS affiliate_name, a.email, a.iban != '' AS has_iban, a.paypal_email != '' AS has_paypal, (SELECT COUNT(*) FROM affiliate_commissions c WHERE c.payout_id = o.id) AS commissions
         FROM affiliate_payouts o JOIN affiliates a ON a.id = o.affiliate_id WHERE o.location_id = ? ORDER BY o.created_at DESC LIMIT 1000`,
        ctx.locationId,
      ),
    );
    /** Bundles each affiliate's approved, unpaid commissions into a payout once they reach the program's threshold. */
    router.post('/api/affiliates/payouts', 'location', (ctx) => {
      const created: any[] = [];
      const skipped: { affiliate: string; balance_cents: number; threshold_cents: number }[] = [];
      const month = today(app, ctx.locationId).slice(0, 7);
      db.tx(() => {
        for (const a of db.all(`SELECT a.*, p.payout_threshold_cents, p.name AS program_name FROM affiliates a JOIN affiliate_programs p ON p.id = a.program_id WHERE a.location_id = ? AND a.status != 'blocked'${ctx.body?.program_id ? ' AND a.program_id = ?' : ''}`, ctx.locationId, ...(ctx.body?.program_id ? [String(ctx.body.program_id)] : []))) {
          const rows = db.all(`SELECT id, amount_cents FROM affiliate_commissions WHERE affiliate_id = ? AND status = 'approved' AND payout_id IS NULL`, a.id);
          const sum = rows.reduce((n, r) => n + r.amount_cents, 0);
          if (!rows.length) continue;
          if (sum <= 0 || sum < a.payout_threshold_cents) {
            skipped.push({ affiliate: a.name || a.email, balance_cents: sum, threshold_cents: a.payout_threshold_cents });
            continue;
          }
          const o = { id: id(), location_id: ctx.locationId, affiliate_id: a.id, amount_cents: sum, currency: 'EUR', method: a.payout_method, reference: `Provision ${a.program_name} ${month} ${a.code}`.slice(0, 140), status: 'open', created_at: now() };
          db.insert('affiliate_payouts', o);
          for (const r of rows) db.run('UPDATE affiliate_commissions SET payout_id = ? WHERE id = ?', o.id, r.id);
          created.push({ ...o, affiliate_name: a.name, email: a.email });
        }
      });
      return { created, skipped };
    });
    router.post('/api/affiliates/payouts/:id/paid', 'location', (ctx) => {
      const o = db.get('SELECT * FROM affiliate_payouts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound();
      if (o.status === 'paid') return o;
      db.tx(() => {
        db.run(`UPDATE affiliate_payouts SET status = 'paid', paid_at = ? WHERE id = ?`, now(), o.id);
        db.run(`UPDATE affiliate_commissions SET status = 'paid', paid_at = ? WHERE payout_id = ?`, now(), o.id);
      });
      return db.get('SELECT * FROM affiliate_payouts WHERE id = ?', o.id);
    });
    router.delete('/api/affiliates/payouts/:id', 'location', (ctx) => {
      const o = db.get('SELECT * FROM affiliate_payouts WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!o) throw notFound();
      if (o.status === 'paid') throw bad('Ausgezahlte Auszahlungen bleiben erhalten');
      db.tx(() => {
        db.run('UPDATE affiliate_commissions SET payout_id = NULL WHERE payout_id = ?', o.id);
        db.run('DELETE FROM affiliate_payouts WHERE id = ?', o.id);
      });
      return { ok: true };
    });
    router.get('/api/affiliates/payouts/export.csv', 'location', (ctx) => {
      const r = text('\ufeff' + payoutCsv(payoutLines(ctx.locationId, idsOf(ctx))), 'text/csv; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="affiliate-auszahlungen-${today(app, ctx.locationId)}.csv"`;
      return r;
    });
    router.get('/api/affiliates/payouts/sepa.xml', 'location', (ctx) => {
      const loc = app.location(ctx.locationId)!;
      const inv = loc.settings.invoices ?? {};
      if (!inv.iban || !validIban(inv.iban)) throw bad('Für die SEPA-Datei fehlt deine IBAN (Einstellungen → Rechnungen)');
      const lines = payoutLines(ctx.locationId, idsOf(ctx)).filter((l) => l.method !== 'paypal');
      if (!lines.some((l) => validIban(l.iban))) throw bad('Keine Auszahlung mit gültiger IBAN');
      // Execution date = the next calendar day in the sub-account's zone (a UTC "tomorrow" is today between 00:00 and 02:00 in Berlin).
      const tomorrow = addDaysYmd(today(app, ctx.locationId), 1);
      const r = text(sepaXml({ name: loc.name, iban: inv.iban, bic: inv.bic }, lines, { msgId: `AFF-${Date.now()}`, executionDate: tomorrow }), 'application/xml; charset=utf-8');
      r.headers['content-disposition'] = `attachment; filename="sepa-affiliates-${tomorrow}.xml"`;
      return r;
    });

    router.get('/api/affiliates/overview', 'location', (ctx) => {
      const n = (sql: string) => db.get<{ n: number }>(sql, ctx.locationId)!.n;
      return {
        programs: n('SELECT COUNT(*) AS n FROM affiliate_programs WHERE location_id = ?'),
        affiliates: n("SELECT COUNT(*) AS n FROM affiliates WHERE location_id = ? AND status = 'active'"),
        pending_affiliates: n("SELECT COUNT(*) AS n FROM affiliates WHERE location_id = ? AND status = 'pending'"),
        clicks: n('SELECT COUNT(*) AS n FROM affiliate_clicks WHERE location_id = ? AND counted = 1'),
        leads: n('SELECT COUNT(*) AS n FROM affiliate_referrals WHERE location_id = ?'),
        sales: n("SELECT COUNT(*) AS n FROM affiliate_commissions WHERE location_id = ? AND kind != 'clawback' AND status != 'reversed' AND invoice_id IS NOT NULL"),
        revenue_cents: n("SELECT COALESCE(SUM(base_cents), 0) AS n FROM affiliate_commissions WHERE location_id = ? AND kind != 'clawback' AND status != 'reversed'"),
        pending_cents: n("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM affiliate_commissions WHERE location_id = ? AND status = 'pending'"),
        approved_cents: n("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM affiliate_commissions WHERE location_id = ? AND status = 'approved'"),
        paid_cents: n("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM affiliate_commissions WHERE location_id = ? AND status = 'paid'"),
      };
    });

    // --- admin API: affiliates (after the fixed paths above) -------------------------------------------
    router.get('/api/affiliates', 'location', (ctx) => {
      const where = ['a.location_id = ?'];
      const params: any[] = [ctx.locationId];
      if (ctx.query.get('program_id')) (where.push('a.program_id = ?'), params.push(ctx.query.get('program_id')));
      if (ctx.query.get('status')) (where.push('a.status = ?'), params.push(ctx.query.get('status')));
      return withStats(where.join(' AND '), ...params);
    });
    router.post('/api/affiliates', 'location', (ctx) => {
      const p = program(String(ctx.body?.program_id ?? ''), ctx.locationId);
      if (!p) throw bad('Programm wählen');
      const row = createAffiliate(p, ctx.body ?? {}, 'manual');
      return withStats('a.id = ?', row.id)[0];
    });
    router.patch('/api/affiliates/:id', 'location', (ctx) => {
      const a = affiliate(ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      const b = ctx.body ?? {};
      const patch: Record<string, any> = { updated_at: now() };
      if (b.status !== undefined) {
        if (!['pending', 'active', 'blocked'].includes(b.status)) throw bad('Unbekannter Status');
        patch.status = b.status;
      }
      if (b.name !== undefined) patch.name = str(b.name, 'Name', { max: 120 });
      if (b.code !== undefined) {
        const code = cleanRef(b.code);
        if (code.length < 3) throw bad('Code: mindestens 3 Zeichen (a–z, 0–9, - und _)');
        if (db.get('SELECT id FROM affiliates WHERE location_id = ? AND code = ? AND id != ?', a.location_id, code, a.id)) throw bad('Code schon vergeben');
        patch.code = code;
      }
      if (b.iban !== undefined) {
        const iban = cleanIban(b.iban);
        if (iban && !validIban(iban)) throw bad('IBAN ist ungültig');
        patch.iban = iban;
      }
      if (b.bic !== undefined) patch.bic = str(b.bic, 'BIC', { max: 11 }).toUpperCase();
      if (b.paypal_email !== undefined) patch.paypal_email = normalizeEmail(b.paypal_email);
      if (b.payout_method !== undefined) patch.payout_method = b.payout_method === 'paypal' ? 'paypal' : 'sepa';
      if (b.notes !== undefined) patch.notes = str(b.notes, 'Notiz', { max: 2000 });
      db.update('affiliates', a.id, patch);
      if (patch.status === 'active' && a.status === 'pending' && a.contact_id) logActivity(app, a.location_id, a.contact_id, 'affiliate.approved', 'Affiliate freigeschaltet');
      return withStats('a.id = ?', a.id)[0];
    });
    router.delete('/api/affiliates/:id', 'location', (ctx) => {
      db.run('DELETE FROM affiliates WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      return { ok: true };
    });
    router.post('/api/affiliates/:id/login-link', 'location', async (ctx) => {
      const a = affiliate(ctx.params.id, ctx.locationId);
      if (!a) throw notFound();
      const r = await sendLoginLink(a);
      // Without a mail provider nothing leaves the server; admins get the link to test with.
      return { status: r.status, link: r.status === 'logged' && ctx.user?.role === 'admin' ? r.link : undefined };
    });

    // --- portal: magic-link login, sessions -------------------------------------------------------------
    const cookieName = (p: any) => `pa_${p.id}`;
    const bySlug = (slug: string) => db.get('SELECT * FROM affiliate_programs WHERE slug = ?', String(slug).toLowerCase());
    const brandOf = (p: any) => {
      const loc = app.location(p.location_id)!;
      const b = loc.settings?.branding ?? {};
      return { loc, name: b.name || loc.name, color: [b.color].find((c) => HEX.test(c ?? '')) ?? '#2563eb', logo: b.logo_url || loc.logo_url || '', support: b.support_email || loc.email || '' };
    };
    // Browsers send Origin on form posts (or at least Sec-Fetch-Site); a foreign origin is refused.
    const sameOrigin = (ctx: Ctx) => {
      const o = ctx.req.headers.origin;
      if (ctx.req.headers['sec-fetch-site'] === 'same-origin' && (!o || o === 'null')) return true;
      if (!o || o === 'null') return !o;
      try {
        return new URL(String(o)).host === String(ctx.req.headers.host ?? '');
      } catch {
        return false;
      }
    };
    const base = (p: any) => `/affiliate/${encodeURIComponent(p.slug)}`;
    const page = (p: any, opts: { title: string; body: string; who?: any; status?: number }): RawResult => {
      const b = brandOf(p);
      const brand = b.logo ? `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(b.name)}">` : `<span class="mark">${escapeHtml(b.name.slice(0, 1).toUpperCase())}</span><span>${escapeHtml(b.name)}</span>`;
      const who = opts.who ? `<div class="who"><span>${escapeHtml(opts.who.name || opts.who.email)}</span><form method="post" action="${base(p)}/logout"><button class="linkbtn">Abmelden</button></form></div>` : '';
      const doc = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · ${escapeHtml(p.name)}</title><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="same-origin">
<style>:root{--brand:${b.color};--soft:${b.color}1f}${PORTAL_CSS}</style></head>
<body><header class="top"><div class="in"><span class="brand">${brand}</span><span class="muted small">Partnerprogramm</span>${who}</div></header><main>${opts.body}</main></body></html>`;
      const r = html(doc, opts.status ?? 200);
      Object.assign(r.headers, { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
      return r;
    };
    const unknown = () => html('<!doctype html><meta charset="utf-8"><title>Nicht gefunden</title><p style="font-family:system-ui;padding:40px;text-align:center">Dieses Partnerprogramm gibt es nicht.</p>', 404);
    const memberOf = (ctx: Ctx, p: any): any => {
      const raw = ctx.cookies[cookieName(p)];
      if (!raw) return undefined;
      const s = db.get('SELECT * FROM affiliate_sessions WHERE token_hash = ? AND expires_at > ?', sha256(raw), now());
      const a = s && affiliate(s.affiliate_id);
      return a && a.program_id === p.id && a.status !== 'blocked' ? { ...a, sessionHash: s.token_hash } : undefined;
    };

    async function sendLoginLink(a: any): Promise<{ status: string; link: string }> {
      const p = program(a.program_id)!;
      const b = brandOf(p);
      const raw = token(32);
      db.insert('affiliate_login_tokens', { token_hash: sha256(raw), affiliate_id: a.id, created_at: now(), expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString() });
      const link = `${portalUrl(p)}/auth?token=${encodeURIComponent(raw)}`;
      const hello = a.name ? `Hallo ${a.name}` : 'Hallo';
      const r = await mailer(b.loc, {
        to: a.email,
        subject: `Dein Login für das Partnerprogramm „${p.name}“`,
        text: `${hello},\n\nhier ist dein Login-Link für das Partnerprogramm „${p.name}“:\n${link}\n\nDer Link gilt 30 Minuten und funktioniert genau einmal.\n\n${b.name}`,
        html: `<p>${escapeHtml(hello)},</p><p>mit diesem Link meldest du dich im Partnerbereich „${escapeHtml(p.name)}“ an:</p><p><a href="${escapeHtml(link)}" style="display:inline-block;background:${b.color};color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">Jetzt anmelden</a></p><p style="color:#64748b;font-size:13px">Der Link gilt 30 Minuten und funktioniert genau einmal.</p>`,
      });
      return { status: r.status, link };
    }

    const ipHits = new Map<string, number[]>();
    const limited = (key: string, max: number) => {
      const t = Date.now();
      const list = (ipHits.get(key) ?? []).filter((x) => t - x < 15 * 60_000);
      list.push(t);
      ipHits.set(key, list);
      if (ipHits.size > 20_000) ipHits.clear();
      return list.length > max;
    };

    const loginPage = (p: any, opts: { error?: string; notice?: string; status?: number } = {}) =>
      page(p, {
        title: 'Anmelden',
        status: opts.status,
        body: `<div class="auth"><div class="panel"><h1>${escapeHtml(p.name)}</h1>
<p class="muted">Melde dich mit deiner E-Mail-Adresse an – du bekommst einen Link, ganz ohne Passwort.</p>
${opts.notice ? `<div class="notice">${escapeHtml(opts.notice)}</div>` : ''}
<form method="post" action="${base(p)}/login"><label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" required autocomplete="email">
${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}<p><button class="btn wide">Login-Link senden</button></p></form>
${p.public_signup ? `<p class="muted small">Noch kein Partner? <a href="${base(p)}/join">Jetzt anmelden</a></p>` : ''}</div></div>`,
      });

    const terms = (p: any) => {
      const value = p.commission_type === 'fixed' ? money(p.commission_value) : `${String(p.commission_value).replace('.', ',')} %`;
      return `${value} Provision${p.commission_type === 'percent' ? ' vom Nettoumsatz' : ' je Verkauf'}${p.recurring ? ', auch auf Abo-Verlängerungen' : ''} · ${p.cookie_days} Tage Cookie-Laufzeit · ${p.attribution === 'first' ? 'erster' : 'letzter'} Klick zählt · Auszahlung ab ${money(p.payout_threshold_cents)}`;
    };

    const dashboard = (p: any, a: any, notice = '') => {
      const s = withStats('a.id = ?', a.id)[0];
      const comms = db.all('SELECT created_at, kind, amount_cents, currency, status FROM affiliate_commissions WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 50', a.id);
      const payouts = db.all('SELECT created_at, amount_cents, currency, status, paid_at, method FROM affiliate_payouts WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 24', a.id);
      const pill = (st: string) => `<span class="pill${st === 'paid' || st === 'approved' ? ' ok' : st === 'reversed' ? ' off' : ''}">${escapeHtml(STATUS_DE[st] ?? st)}</span>`;
      const tile = (label: string, v: string) => `<div class="tile"><span class="muted small">${label}</span><b>${v}</b></div>`;
      const kind = (k: string) => (k === 'recurring' ? 'Abo-Verlängerung' : k === 'clawback' ? 'Rückbuchung' : k === 'manual' ? 'Gutschrift' : 'Verkauf');
      return page(p, {
        title: 'Partnerbereich',
        who: a,
        body: `${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}
<h1>Hallo${a.name ? ` ${escapeHtml(a.name.split(' ')[0])}` : ''} 👋</h1>
<p class="muted">${escapeHtml(terms(p))}</p>
${a.status === 'pending' ? '<div class="panel"><strong>Deine Anmeldung wird geprüft.</strong> <span class="muted">Sobald sie freigegeben ist, zählen deine Klicks und Verkäufe.</span></div>' : ''}
<div class="panel"><h2>Dein Link</h2><input class="copy" readonly value="${escapeHtml(s.link)}" aria-label="Dein Partner-Link">
<p class="muted small" style="margin-bottom:0">Du kannst <code>?ref=${escapeHtml(a.code)}</code> auch an jede andere Seite von uns hängen. Dein Code: <strong>${escapeHtml(a.code)}</strong></p></div>
<div class="tiles">${tile('Klicks', String(s.clicks))}${tile('Leads', String(s.leads))}${tile('Verkäufe', String(s.sales))}${tile('Provision offen', money(s.pending_cents))}${tile('Freigegeben', money(s.approved_cents))}${tile('Ausgezahlt', money(s.paid_cents))}</div>
<div class="grid2"><div class="panel scroll"><h2>Provisionen</h2>${comms.length ? `<table><thead><tr><th>Datum</th><th>Art</th><th>Betrag</th><th>Status</th></tr></thead><tbody>${comms.map((c) => `<tr><td>${new Date(c.created_at).toLocaleDateString('de-DE')}</td><td>${kind(c.kind)}</td><td>${money(c.amount_cents, c.currency)}</td><td>${pill(c.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Noch keine Provisionen.</p>'}</div>
<div class="panel scroll"><h2>Auszahlungen</h2>${payouts.length ? `<table><thead><tr><th>Datum</th><th>Betrag</th><th>Status</th></tr></thead><tbody>${payouts.map((o) => `<tr><td>${new Date(o.paid_at || o.created_at).toLocaleDateString('de-DE')}</td><td>${money(o.amount_cents, o.currency)}</td><td>${pill(o.status)}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">Noch keine Auszahlung. Ausgezahlt wird ab ${money(p.payout_threshold_cents)} freigegebener Provision.</p>`}</div></div>
<div class="panel"><h2>Auszahlungsdaten</h2><form method="post" action="${base(p)}/settings">
<label>Auszahlung per</label><select name="payout_method"><option value="sepa"${a.payout_method !== 'paypal' ? ' selected' : ''}>Überweisung (SEPA)</option><option value="paypal"${a.payout_method === 'paypal' ? ' selected' : ''}>PayPal</option></select>
<div class="grid2"><div><label for="iban">IBAN</label><input id="iban" name="iban" value="${escapeHtml(a.iban)}" autocomplete="off"></div><div><label for="bic">BIC (optional)</label><input id="bic" name="bic" value="${escapeHtml(a.bic)}"></div></div>
<label for="paypal">PayPal-E-Mail</label><input id="paypal" name="paypal_email" type="email" value="${escapeHtml(a.paypal_email)}">
<p><button class="btn">Speichern</button></p></form></div>`,
      });
    };

    router.get('/affiliate/:program', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p || !p.active) return unknown();
      const a = memberOf(ctx, p);
      return a ? dashboard(p, a) : loginPage(p);
    });
    router.get('/affiliate/:program/join', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p || !p.active || !p.public_signup) return unknown();
      return joinPage(p);
    });
    const joinPage = (p: any, opts: { error?: string; values?: any; status?: number } = {}) =>
      page(p, {
        title: 'Partner werden',
        status: opts.status,
        body: `<div class="auth"><div class="panel"><h1>Partner werden</h1><p class="muted">${escapeHtml(terms(p))}</p>
<form method="post" action="${base(p)}/join">
<label for="name">Name</label><input id="name" name="name" required autocomplete="name" value="${escapeHtml(opts.values?.name ?? '')}">
<label for="email">E-Mail-Adresse</label><input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(opts.values?.email ?? '')}">
<input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
${p.terms ? `<p class="muted small" style="white-space:pre-wrap">${escapeHtml(p.terms)}</p>` : ''}
<label class="check"><input type="checkbox" name="accept" value="1" required> Ich akzeptiere die Bedingungen des Partnerprogramms und die Verarbeitung meiner Daten zur Abrechnung.</label>
${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ''}<p><button class="btn wide">Anmelden</button></p></form>
<p class="muted small">Schon Partner? <a href="${base(p)}">Zum Login</a></p></div></div>`,
      });
    router.post('/affiliate/:program/join', 'public', async (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p || !p.active || !p.public_signup) return unknown();
      const values = { name: String(ctx.body?.name ?? '').slice(0, 120), email: String(ctx.body?.email ?? '').slice(0, 200) };
      if (!sameOrigin(ctx)) return joinPage(p, { error: 'Bitte die Seite neu laden und noch einmal versuchen.', values, status: 403 });
      if (ctx.body?.website) return loginPage(p, { notice: 'Danke! Wir melden uns per E-Mail.' });
      if (limited(`join:${ctx.ip}`, 5)) return joinPage(p, { error: 'Zu viele Versuche – bitte später noch einmal.', values, status: 429 });
      if (!ctx.body?.accept) return joinPage(p, { error: 'Bitte die Bedingungen bestätigen.', values, status: 400 });
      try {
        const a = createAffiliate(p, { name: values.name, email: values.email }, 'signup');
        if (a.status === 'active') await sendLoginLink(a).catch((e) => console.error('[affiliates] login mail', e));
        return loginPage(p, { notice: a.status === 'active' ? 'Willkommen! Dein Login-Link ist per E-Mail unterwegs.' : 'Danke für deine Anmeldung! Wir prüfen sie und melden uns per E-Mail.' });
      } catch (e) {
        return joinPage(p, { error: (e as Error).message, values, status: 400 });
      }
    });
    router.post('/affiliate/:program/login', 'public', async (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p || !p.active) return unknown();
      if (!sameOrigin(ctx)) return loginPage(p, { error: 'Bitte die Seite neu laden und noch einmal versuchen.', status: 403 });
      if (limited(`login:${ctx.ip}`, 20)) return loginPage(p, { error: 'Zu viele Versuche – bitte in ein paar Minuten noch einmal.', status: 429 });
      const email = normalizeEmail(ctx.body?.email);
      if (!EMAIL_RE.test(email)) return loginPage(p, { error: 'Bitte eine gültige E-Mail-Adresse eingeben.', status: 400 });
      const a = db.get("SELECT * FROM affiliates WHERE program_id = ? AND email = ? AND status != 'blocked'", p.id, email);
      // Same answer either way (no guessing who is a partner); at most 3 links per 15 minutes.
      if (a && !limited(`mail:${a.id}`, 3)) await sendLoginLink(a).catch((e) => console.error('[affiliates] login mail', e));
      return loginPage(p, { notice: `Wenn ${email} als Partner angemeldet ist, kommt gleich ein Login-Link per E-Mail.` });
    });
    const tokenRow = (raw: string) => (raw ? db.get('SELECT * FROM affiliate_login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(raw), now()) : undefined);
    // Opening the link only shows a button, so mail scanners cannot use it up.
    router.get('/affiliate/:program/auth', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p) return unknown();
      const raw = String(ctx.query.get('token') ?? '');
      const row = tokenRow(raw);
      const a = row && affiliate(row.affiliate_id);
      if (!a || a.program_id !== p.id) return loginPage(p, { error: 'Dieser Link ist abgelaufen oder wurde schon benutzt.', status: 400 });
      return page(p, { title: 'Anmelden', body: `<div class="auth"><div class="panel"><h1>Willkommen zurück</h1><p class="muted">Angemeldet wirst du als <strong>${escapeHtml(a.email)}</strong>.</p><form method="post" action="${base(p)}/auth"><input type="hidden" name="token" value="${escapeHtml(raw)}"><button class="btn wide">Jetzt anmelden</button></form></div></div>` });
    });
    router.post('/affiliate/:program/auth', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p) return unknown();
      const raw = String(ctx.body?.token ?? '');
      const row = tokenRow(raw);
      const a = row && affiliate(row.affiliate_id);
      if (!sameOrigin(ctx) || !a || a.program_id !== p.id || !db.run('UPDATE affiliate_login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL', now(), row.token_hash).changes)
        return loginPage(p, { error: 'Dieser Link ist abgelaufen oder wurde schon benutzt.', status: 400 });
      const sid = token(32);
      db.insert('affiliate_sessions', { token_hash: sha256(sid), affiliate_id: a.id, created_at: now(), expires_at: new Date(Date.now() + SESSION_DAYS * 864e5).toISOString() });
      // Clicks from the partner's own connection are not counted (self-referral).
      db.run('UPDATE affiliates SET login_ip_hash = ? WHERE id = ?', ipHash(ctx.ip), a.id);
      ctx.setCookie(cookieName(p), sid, { maxAge: SESSION_DAYS * 86400 });
      return redirect(base(p), 303);
    });
    router.post('/affiliate/:program/logout', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p) return unknown();
      const a = memberOf(ctx, p);
      if (a) db.run('DELETE FROM affiliate_sessions WHERE token_hash = ?', a.sessionHash);
      ctx.setCookie(cookieName(p), '', { maxAge: 0 });
      return redirect(base(p), 303);
    });
    router.post('/affiliate/:program/settings', 'public', (ctx) => {
      const p = bySlug(ctx.params.program);
      if (!p) return unknown();
      const a = memberOf(ctx, p);
      if (!a || !sameOrigin(ctx)) return redirect(base(p), 303);
      const iban = cleanIban(ctx.body?.iban);
      if (iban && !validIban(iban)) return dashboard(p, a, 'Die IBAN ist ungültig – bitte prüfen.');
      db.update('affiliates', a.id, { payout_method: ctx.body?.payout_method === 'paypal' ? 'paypal' : 'sepa', iban, bic: String(ctx.body?.bic ?? '').trim().toUpperCase().slice(0, 11), paypal_email: normalizeEmail(ctx.body?.paypal_email).slice(0, 200), updated_at: now() });
      return dashboard(p, affiliate(a.id), 'Gespeichert.');
    });
  },
};
