import type { App, Module } from '../core/app.js';
import { HttpError, bad, clampLimit, notFound, num, str, type Ctx } from '../core/http.js';
import { centsToMoney, normalizeEmail, now } from '../core/util.js';
import { getContact, logActivity } from '../services/contacts.js';
import {
  available,
  cardByCode,
  cardById,
  commit,
  giftMailText,
  hold,
  issue,
  ledger,
  maskCode,
  normCode,
  redeem,
  release,
  type GiftCard,
} from '../services/giftcards.js';
import { invAudit, loadInvoice, recordPayment } from '../services/invoice-flow.js';
import { openCents } from '../services/invoice-model.js';
import { composeEmail, deliverEmail, sendToContact } from '../services/messaging.js';

/**
 * Gift cards (docs/store.md#gift-cards): cards with a code and a balance ledger, issued by hand (Umsatz → Gutscheine), sold as a
 * product type in the online store, and redeemed in the store checkout, on invoices and in booking payments (both through the pay
 * page of modules/pay-registry.ts). A payment holds the amount first and commits it when it is complete. The ledger cannot be
 * changed (database triggers) – corrections are new lines. Multi-purpose vouchers: VAT arises on redemption (§ 3 Abs. 15 UStG).
 * Routes /api/gift-cards (area "payments"); the service app.services.giftCards for the registry and the store.
 */

const SQL = `
CREATE TABLE gift_cards (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, code TEXT NOT NULL,
  initial_cents INTEGER NOT NULL DEFAULT 0, balance_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'EUR', status TEXT NOT NULL DEFAULT 'active',
  expires_at TEXT, contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL, recipient_name TEXT NOT NULL DEFAULT '', recipient_email TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', order_id TEXT, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(location_id, code)
);
CREATE INDEX gift_cards_loc ON gift_cards(location_id, created_at);
CREATE INDEX gift_cards_contact ON gift_cards(contact_id);
CREATE INDEX gift_cards_order ON gift_cards(order_id);
CREATE TABLE gift_card_ledger (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, card_id TEXT NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, ref_type TEXT NOT NULL DEFAULT '', ref_id TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX gift_card_ledger_card ON gift_card_ledger(card_id, created_at);
CREATE INDEX gift_card_ledger_loc ON gift_card_ledger(location_id, created_at);
CREATE TRIGGER gift_card_ledger_no_update BEFORE UPDATE ON gift_card_ledger
BEGIN SELECT RAISE(ABORT, 'Das Gutschein-Journal ist unveränderbar – bitte eine Korrekturbuchung'); END;
CREATE TRIGGER gift_card_ledger_no_delete BEFORE DELETE ON gift_card_ledger WHEN EXISTS (SELECT 1 FROM locations WHERE id = OLD.location_id)
BEGIN SELECT RAISE(ABORT, 'Das Gutschein-Journal ist unveränderbar – bitte eine Korrekturbuchung'); END;
CREATE TABLE gift_card_holds (
  ref TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, card_id TEXT NOT NULL REFERENCES gift_cards(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX gift_card_holds_card ON gift_card_holds(card_id, expires_at);
`;

const KIND_LABELS: Record<string, string> = { issue: 'Ausgegeben', redeem: 'Eingelöst', refund: 'Zurückgebucht', adjust: 'Korrektur' };

export const giftCardsModule: Module = {
  name: 'giftcards',
  migrations: [['001-init', SQL]],
  register(app: App) {
    const { db, router } = app;
    const actor = (ctx: Ctx) => (ctx.user ? ctx.user.id : null);
    const isExpired = (c: GiftCard) => !!c.expires_at && c.expires_at < now();
    /** A card as the API shows it; lists pass name and available amount from their one query (no query per row). */
    const out = (c: GiftCard & { contact_name?: string; available_cents?: number }) => {
      const k = c.contact_name === undefined && c.contact_id ? getContact(app, c.location_id, c.contact_id) : undefined;
      return {
        ...c,
        code_masked: maskCode(c.code),
        available_cents: c.available_cents ?? available(app, c),
        state: c.status !== 'active' ? 'disabled' : isExpired(c) ? 'expired' : c.balance_cents <= 0 ? 'used' : 'active',
        contact_name: c.contact_name ?? (k ? [k.first_name, k.last_name].filter(Boolean).join(' ') || k.email || '' : ''),
      };
    };
    const mine = (ctx: Ctx) => {
      const c = cardById(app, ctx.locationId, ctx.params.id);
      if (!c) throw notFound('Gutschein nicht gefunden');
      return c;
    };

    /** Mails the code: to the recipient's address, or to the buyer/contact (a service mail – no consent needed, no unsubscribe link). */
    async function send(c: GiftCard, fromName = ''): Promise<{ status: string; to: string }> {
      const loc = app.location(c.location_id)!;
      const shop = loc.name;
      const m = giftMailText(c, shop, fromName);
      const to = normalizeEmail(c.recipient_email);
      if (to) {
        const mail = composeEmail({ body: m.body, unsubUrl: '', company: loc.name, address: loc.address, unsubscribe: false });
        const r = await deliverEmail(loc, { to, subject: m.subject, html: mail.html, text: mail.text });
        if (c.contact_id) logActivity(app, c.location_id, c.contact_id, 'gift_card.sent', `Gutschein ${maskCode(c.code)} an ${to} geschickt`);
        return { status: r.status, to };
      }
      if (!c.contact_id) throw bad('Weder Empfänger-E-Mail noch Kontakt – an wen soll der Gutschein gehen?');
      const r = await sendToContact(app, c.location_id, { contactId: c.contact_id, channel: 'email', subject: m.subject, body: m.body, source: 'Gutschein', purpose: 'transactional', ignoreDnd: true, track: false });
      return { status: r.status, to: getContact(app, c.location_id, c.contact_id)?.email ?? '' };
    }

    // --- the service for the payment registry, the store and the MCP tools ---------------------------------------------------
    app.services.giftCards = {
      hold: (loc: string, code: string, max: number, ref: string, currency?: string, minRest = 0) => hold(app, loc, code, max, ref, currency, minRest),
      commit: (ref: string, refType: string, refId: string) => commit(app, ref, refType, refId),
      release: (ref: string) => release(app, ref),
      activeIn: (loc: string) => !!db.get(`SELECT 1 AS x FROM gift_cards WHERE location_id = ? AND status = 'active' AND balance_cents > 0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`, loc, now()),
      refund: (loc: string, cardId: string, amount: number, refType: string, refId: string) => {
        const c = cardById(app, loc, cardId);
        if (c && amount > 0) ledger(app, c, 'refund', amount, { type: refType, id: refId, note: 'Erstattung' });
      },
      mask: (loc: string, cardId: string) => {
        const c = cardById(app, loc, cardId);
        return c ? maskCode(c.code) : '';
      },
      check: (loc: string, code: string, currency?: string) => {
        const c = cardByCode(app, loc, code);
        if (!c || c.status !== 'active' || isExpired(c) || (currency && c.currency !== currency)) return null;
        return { id: c.id, available_cents: available(app, c), currency: c.currency, expires_at: c.expires_at };
      },
      issue: (loc: string, o: Parameters<typeof issue>[2]) => issue(app, loc, o),
      send: (c: GiftCard, fromName = '') => send(c, fromName),
      /**
       * The gift-card part of a pay session for an invoice: booked as a payment "Gutschein". What does not fit any more (the invoice
       * was paid otherwise in between) goes back onto the card, and the invoice's trail says so.
       */
      payInvoice: (loc: string, invoiceId: string, cardId: string, amount: number, ref: string) => {
        const inv = loadInvoice(app, loc, invoiceId);
        const open = inv && inv.kind === 'invoice' && inv.status !== 'paid' && inv.status !== 'void' ? openCents(inv) : 0;
        const take = Math.min(open, amount);
        const masked = app.services.giftCards.mask(loc, cardId);
        if (take > 0) recordPayment(app, loc, invoiceId, { amount_cents: take, method: 'Gutschein', note: `${masked} · ${ref}` }, { id: null, name: 'Automatik (Gutschein)' }, { source: 'auto', via: 'Gutschein' });
        if (amount > take) {
          app.services.giftCards.refund(loc, cardId, amount - take, 'invoice', invoiceId);
          invAudit(app, loc, invoiceId, 'payment.mismatch', `Gutschein ${masked}: ${centsToMoney(amount - take, inv?.currency ?? 'EUR')} passten nicht mehr auf die Rechnung und sind wieder auf dem Gutschein`);
        }
        return take;
      },
    };

    // --- admin ------------------------------------------------------------------------------------------------------------------
    router.get('/api/gift-cards', 'location', (ctx) => {
      const at = now();
      const where = ['g.location_id = ?'];
      const args: (string | number)[] = [at, ctx.locationId];
      const q = String(ctx.query.get('q') ?? '').trim().slice(0, 80);
      if (q) {
        where.push(`(g.code LIKE ? OR g.recipient_name LIKE ? OR g.recipient_email LIKE ? OR g.note LIKE ?)`);
        args.push(`%${normCode(q) || q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
      }
      const st = ctx.query.get('status');
      if (st === 'active') {
        where.push(`g.status = 'active' AND g.balance_cents > 0 AND (g.expires_at IS NULL OR g.expires_at > ?)`);
        args.push(at);
      } else if (st === 'used') where.push('g.balance_cents <= 0');
      else if (st === 'disabled') where.push(`g.status = 'disabled'`);
      const rows = db.all<GiftCard & { contact_name: string; available_cents: number }>(
        `SELECT g.*, TRIM(COALESCE(k.first_name, '') || ' ' || COALESCE(k.last_name, '')) AS contact_name,
           g.balance_cents - COALESCE((SELECT SUM(h.amount_cents) FROM gift_card_holds h WHERE h.card_id = g.id AND h.expires_at > ?), 0) AS available_cents
         FROM gift_cards g LEFT JOIN contacts k ON k.id = g.contact_id WHERE ${where.join(' AND ')} ORDER BY g.created_at DESC LIMIT ${clampLimit(ctx.query.get('limit'), 200, 1000)}`,
        ...args,
      );
      const totals = db.get<{ n: number; open: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'active' THEN balance_cents ELSE 0 END), 0) AS open FROM gift_cards WHERE location_id = ?`, ctx.locationId)!;
      return { cards: rows.map(out), count: totals.n, outstanding_cents: totals.open };
    });
    router.post('/api/gift-cards', 'location', async (ctx) => {
      const b = ctx.body ?? {};
      let contactId: string | null = null;
      if (b.contact_id) {
        if (!getContact(app, ctx.locationId, String(b.contact_id))) throw bad('Kontakt nicht gefunden');
        contactId = String(b.contact_id);
      }
      const email = normalizeEmail(b.recipient_email ?? '');
      if (b.recipient_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Empfänger-E-Mail ist ungültig');
      const expires = b.expires_at ? new Date(String(b.expires_at)) : null;
      if (expires && (Number.isNaN(expires.getTime()) || expires.getTime() < Date.now())) throw bad('Das Ablaufdatum muss in der Zukunft liegen');
      const card = issue(app, ctx.locationId, {
        amount_cents: Math.round(num(b.amount_cents, 0)),
        currency: b.currency,
        expires_at: expires ? expires.toISOString() : null,
        contact_id: contactId,
        recipient_name: str(b.recipient_name, 'Empfänger', { max: 120 }),
        recipient_email: email,
        message: str(b.message, 'Nachricht', { max: 500 }),
        note: str(b.note, 'Notiz', { max: 300 }),
        code: b.code ? String(b.code) : undefined,
        source: 'manual',
        by: actor(ctx),
      });
      if (contactId) logActivity(app, ctx.locationId, contactId, 'gift_card.issued', `Gutschein ${maskCode(card.code)} über ${centsToMoney(card.initial_cents, card.currency)}`);
      const sent = b.send ? await send(card).catch((e) => ({ status: 'failed', to: '', error: (e as Error).message })) : null;
      return { ...out(card), sent };
    });
    router.get('/api/gift-cards/:id', 'location', (ctx) => {
      const c = mine(ctx);
      const lines = db.all('SELECT * FROM gift_card_ledger WHERE card_id = ? ORDER BY created_at, rowid', c.id).map((l: any) => ({ ...l, kind_label: KIND_LABELS[l.kind] ?? l.kind }));
      const holds = db.all('SELECT ref, amount_cents, expires_at, created_at FROM gift_card_holds WHERE card_id = ? AND expires_at > ?', c.id, now());
      return { ...out(c), ledger: lines, holds };
    });
    router.patch('/api/gift-cards/:id', 'location', (ctx) => {
      const c = mine(ctx);
      const b = ctx.body ?? {};
      const patch: Record<string, unknown> = { updated_at: now() };
      if (b.status !== undefined) patch.status = b.status === 'disabled' ? 'disabled' : 'active';
      if (b.expires_at !== undefined) {
        const d = b.expires_at ? new Date(String(b.expires_at)) : null;
        if (d && Number.isNaN(d.getTime())) throw bad('Ungültiges Ablaufdatum');
        patch.expires_at = d ? d.toISOString() : null;
      }
      if (b.note !== undefined) patch.note = str(b.note, 'Notiz', { max: 300 });
      if (b.recipient_name !== undefined) patch.recipient_name = str(b.recipient_name, 'Empfänger', { max: 120 });
      if (b.recipient_email !== undefined) {
        const e = normalizeEmail(b.recipient_email);
        if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw bad('Empfänger-E-Mail ist ungültig');
        patch.recipient_email = e;
      }
      db.update('gift_cards', c.id, patch, ctx.locationId);
      return out(cardById(app, ctx.locationId, c.id)!);
    });
    router.post('/api/gift-cards/:id/adjust', 'location', (ctx) => {
      const c = mine(ctx);
      const amount = Math.round(num(ctx.body?.amount_cents, 0));
      if (!amount) throw bad('Betrag fehlt (positiv: aufladen, negativ: abziehen)');
      const note = str(ctx.body?.note, 'Grund', { required: true, max: 300 });
      if (c.balance_cents + amount < 0) throw new HttpError(409, `Höchstens ${centsToMoney(c.balance_cents, c.currency)} lassen sich abziehen`);
      ledger(app, c, 'adjust', amount, { type: 'manual', note, by: actor(ctx) });
      return out(cardById(app, ctx.locationId, c.id)!);
    });
    router.post('/api/gift-cards/:id/send', 'location', async (ctx) => {
      const c = mine(ctx);
      try {
        return await send(c);
      } catch (e) {
        throw e instanceof HttpError ? e : bad((e as Error).message);
      }
    });
    /** Look up a code (the counter, the phone): balance and validity. */
    router.post('/api/gift-cards/check', 'location', (ctx) => {
      const c = cardByCode(app, ctx.locationId, String(ctx.body?.code ?? ''));
      if (!c) throw notFound('Diesen Gutscheincode gibt es nicht');
      return out(c);
    });
    /** Redeem by hand (shop counter, phone order, an invoice): takes up to `amount_cents`; with `invoice_id` it is booked on the invoice. */
    router.post('/api/gift-cards/redeem', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const code = String(b.code ?? '');
      if (b.invoice_id) {
        const inv = loadInvoice(app, ctx.locationId, String(b.invoice_id));
        if (!inv || inv.kind !== 'invoice') throw notFound('Rechnung nicht gefunden');
        const open = inv.status === 'paid' || inv.status === 'void' ? 0 : openCents(inv);
        if (open <= 0) throw new HttpError(409, 'Auf dieser Rechnung ist nichts offen');
        return db.tx(() => {
          const r = redeem(app, ctx.locationId, code, Math.min(open, Math.round(num(b.amount_cents, open)) || open), 'invoice', inv.id, inv.currency);
          recordPayment(app, ctx.locationId, inv.id, { amount_cents: r.amount, method: 'Gutschein', note: maskCode(r.card.code) }, { id: actor(ctx), name: ctx.user?.name ?? 'API' }, { source: 'manual', via: 'Gutschein' });
          return { amount_cents: r.amount, card: out(cardById(app, ctx.locationId, r.card.id)!) };
        });
      }
      const amount = Math.round(num(b.amount_cents, 0));
      if (amount <= 0) throw bad('Betrag fehlt');
      const r = redeem(app, ctx.locationId, code, amount, 'manual', str(b.note, 'Notiz', { max: 120 }));
      return { amount_cents: r.amount, card: out(cardById(app, ctx.locationId, r.card.id)!) };
    });

    // --- DSGVO: cards are money (kept, the ledger cannot be deleted); the person's link and the recipient's data go --------------
    app.services.privacyErase = [
      ...(app.services.privacyErase ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        db.run('UPDATE gift_cards SET contact_id = NULL WHERE location_id = ? AND contact_id = ?', loc, contact.id);
        if (email) db.run(`UPDATE gift_cards SET recipient_name = '', recipient_email = '', message = '' WHERE location_id = ? AND lower(recipient_email) = ?`, loc, email);
      },
    ];
    app.services.privacyExport = [
      ...(app.services.privacyExport ?? []),
      (_a: App, loc: string, contact: { id: string; email?: string }) => {
        const email = normalizeEmail(contact.email);
        if (!email) return {};
        const rows = db.all('SELECT code, initial_cents, balance_cents, currency, status, expires_at, recipient_name, recipient_email, message, created_at FROM gift_cards WHERE location_id = ? AND lower(recipient_email) = ? AND (contact_id IS NULL OR contact_id != ?)', loc, email, contact.id);
        return rows.length ? { 'gift_cards (Empfänger)': rows } : {};
      },
    ];
    // Holds of payments that never finished (the session lapses and releases them; this is the safety net).
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 3600_000) return;
      swept = Date.now();
      db.run('DELETE FROM gift_card_holds WHERE expires_at < ?', now());
    });
  },
};
