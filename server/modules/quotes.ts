import type { Module } from '../core/app.js';
import { HttpError, bad, clampLimit, html, notFound, str, type Ctx } from '../core/http.js';
import { messagePage } from '../core/page.js';
import { now } from '../core/util.js';
import { SYSTEM, convertEstimate, mustInvoice } from '../services/invoice-flow.js';
import { denyUnless, permits, resolve, scopeClause } from '../services/record-access.js';
import { acceptQuote, createQuote, declineQuote, duplicateQuote, expireQuotes, getQuote, invoicePaid, markViewed, quoteByToken, quoteOut, quoteStats, sendQuote, updateQuote, voidQuote, type QuoteRow } from '../services/quote-engine.js';
import { totalsHtml, quoteHtml } from '../services/quote-page.js';
import { QUOTE_STATUSES, QUOTE_STATUS_LABEL, resolveSelection, quoteTotals } from '../services/quote-model.js';
import { LineError } from '../services/sales-lines.js';
import { registerTriggers, type TriggerMeta } from '../services/wfx-kit.js';
import type { Tool } from './mcp.js';

/**
 * Angebote aus dem Deal (docs/sales.md): Positionen, Varianten zur Auswahl, optionale Positionen, Anzahlung, Gültigkeit – eine
 * Angebotsseite, auf der der Kunde wählt, annimmt und unterschreibt (Vertragsdatensatz mit Prüfsumme), danach Angebot mit Nummer,
 * Anzahlungs- oder Rechnung mit Stripe-Zahlungslink. Die Logik steht in services/quote-engine.ts, die Rechenregeln in sales-lines.ts
 * und quote-model.ts, die Seite in quote-page.ts.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects); mit einem Sub-Account-Schlüssel weglassen' } };
const ITEM = {
  type: 'object',
  properties: {
    product_id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    qty: { type: 'number' },
    price_cents: { type: 'number' },
    discount_type: { type: 'string', enum: ['none', 'percent', 'amount'] },
    discount_value: { type: 'number' },
    tax_rate: { type: 'number' },
    optional: { type: 'boolean', description: 'Der Kunde entscheidet, ob die Position dazukommt' },
    selected: { type: 'boolean', description: 'Optional: vorangekreuzt' },
  },
};
const TOOLS: Tool[] = [
  {
    name: 'ghl_quote_list',
    title: 'Angebote auflisten',
    description: 'Angebote (Nummer, Titel, Status, Summe, Deal, Kontakt, gültig bis) mit Kennzahlen. Filter: status (draft|sent|viewed|accepted|declined|expired|void), deal_id. Nur lesen.',
    inputSchema: { type: 'object', properties: { ...LOC, status: { type: 'string', enum: [...QUOTE_STATUSES] }, deal_id: { type: 'string' } }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `/api/quotes?${new URLSearchParams({ ...(a.status ? { status: a.status } : {}), ...(a.deal_id ? { deal_id: a.deal_id } : {}) })}`, { location: a.location_id }),
  },
  {
    name: 'ghl_quote_create',
    title: 'Angebot aus einem Deal anlegen',
    description:
      'Legt ein Angebot als Entwurf an. Ohne items startet es mit den Positionen des Deals. items: gemeinsame Positionen; options: Varianten zur Auswahl ([{name, description, recommended, items}]); optional=true macht eine Position zur Auswahl des Kunden. Danach ghl_quote_send.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        deal_id: { type: 'string' },
        title: { type: 'string' },
        valid_days: { type: 'number', description: 'Gültig für so viele Tage (Standard 30)' },
        intro: { type: 'string' },
        terms: { type: 'string' },
        items: { type: 'array', items: ITEM },
        options: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, recommended: { type: 'boolean' }, items: { type: 'array', items: ITEM } }, required: ['name', 'items'] } },
        payment: { type: 'object', properties: { mode: { type: 'string', enum: ['none', 'deposit', 'full'] }, type: { type: 'string', enum: ['percent', 'amount'] }, value: { type: 'number' } }, description: 'Was bei Annahme fällig wird: Anzahlung (Prozent oder Netto-Betrag in Cent) oder der volle Betrag' },
      },
      required: ['deal_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    run: async (call, a) => {
      const created = await call.api('POST', '/api/quotes', { location: a.location_id, body: { deal_id: a.deal_id, title: a.title, valid_days: a.valid_days, items: a.items, options: a.options } });
      const extra = Object.fromEntries(Object.entries({ intro: a.intro, terms: a.terms, payment: a.payment }).filter(([, v]) => v !== undefined));
      return Object.keys(extra).length ? call.api('PATCH', `/api/quotes/${encodeURIComponent((created as any).id)}`, { location: a.location_id, body: extra }) : created;
    },
  },
  {
    name: 'ghl_quote_send',
    title: 'Angebot senden',
    description: 'Vergibt die Angebotsnummer und schickt dem Kontakt den Link zur Angebotsseite per E-Mail (deliver=false: nur freigeben und den Link zurückgeben, z. B. zum Teilen im Chat). Der Kunde wählt, nimmt an und unterschreibt dort selbst.',
    inputSchema: { type: 'object', properties: { ...LOC, quote_id: { type: 'string' }, deliver: { type: 'boolean' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['quote_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (call, a) => call.api('POST', `/api/quotes/${encodeURIComponent(a.quote_id)}/send`, { location: a.location_id, body: { deliver: a.deliver, subject: a.subject, body: a.body } }),
  },
];

const TRIGGERS: TriggerMeta[] = (
  [
    ['quote.sent', 'Angebot gesendet', 'Ein Angebot wird an den Kontakt geschickt.'],
    ['quote.viewed', 'Angebot geöffnet', 'Der Kontakt öffnet die Angebotsseite zum ersten Mal.'],
    ['quote.accepted', 'Angebot angenommen und unterschrieben', 'Der Kontakt nimmt ein Angebot auf der Angebotsseite an und unterschreibt.'],
    ['quote.declined', 'Angebot abgelehnt', 'Der Kontakt lehnt ein Angebot ab.'],
    ['quote.expired', 'Angebot abgelaufen', 'Die Gültigkeit eines Angebots endet, ohne dass der Kontakt geantwortet hat.'],
    ['quote.paid', 'Angebots-Rechnung bezahlt', 'Die bei Annahme erstellte Anzahlungs- oder Rechnung wird bezahlt.'],
  ] as const
).map(([type, label, summary]) => ({
  type,
  label,
  category: 'sales',
  summary,
  doc: `{{event.quote.number}}, {{event.quote.title}}, {{event.quote.total_cents}} (nach Annahme) und {{event.quote.deal_id}} sind verfügbar. Zum Nachfassen z. B. mit „Warten“ und einer Aufgabe für den Zuständigen.`,
  fields: [],
  sample: { quote: { id: 'q1', number: 'AN-1001', title: 'Webseite', status: 'sent', deal_id: 'd1', currency: 'EUR', total_cents: 595000, valid_until: '2026-12-01' } },
  keywords: 'angebot quote offerte unterschrift vertrieb',
}));

export const quotesModule: Module = {
  name: 'quotes',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE deal_quotes (
        id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
        deal_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        number TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft',
        currency TEXT NOT NULL DEFAULT 'EUR', tax_mode TEXT NOT NULL DEFAULT 'standard', intro TEXT NOT NULL DEFAULT '', terms TEXT NOT NULL DEFAULT '',
        valid_until TEXT, doc TEXT NOT NULL DEFAULT '{}', payment TEXT NOT NULL DEFAULT '{}', deal_on_accept TEXT NOT NULL DEFAULT 'none',
        public_token TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 1, parent_id TEXT,
        sent_at TEXT, viewed_at TEXT, accepted_at TEXT, declined_at TEXT, decline_reason TEXT NOT NULL DEFAULT '',
        selection TEXT, accepted_total_cents INTEGER, signer_name TEXT NOT NULL DEFAULT '', contract_id TEXT, estimate_id TEXT,
        invoice_id TEXT, invoice_kind TEXT NOT NULL DEFAULT '', final_invoice_id TEXT, paid_at TEXT,
        note TEXT NOT NULL DEFAULT '', created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX deal_quotes_loc ON deal_quotes(location_id, status, updated_at);
      CREATE INDEX deal_quotes_deal ON deal_quotes(deal_id);
      CREATE INDEX deal_quotes_contact ON deal_quotes(contact_id);
      CREATE INDEX deal_quotes_valid ON deal_quotes(valid_until) WHERE status IN ('sent', 'viewed');
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
    registerTriggers(app, TRIGGERS);

    // --- time and payments --------------------------------------------------------------------------------------------------
    let swept = 0;
    app.onTick(() => {
      if (Date.now() - swept < 10 * 60_000) return;
      swept = Date.now();
      expireQuotes(app);
    });
    app.events.on('invoice.paid', (e) => {
      const inv = e.data?.invoice;
      if (inv?.id) invoicePaid(app, e.locationId, inv.id);
    });

    // --- helpers ----------------------------------------------------------------------------------------------------------------
    const asHttp = <T>(fn: () => T): T => {
      try {
        return fn();
      } catch (e) {
        if (e instanceof LineError) throw bad(e.message);
        throw e;
      }
    };
    /** The quote of a request, if the person may see its deal (record-access rules: a quote follows its deal). */
    const must = (ctx: Ctx): QuoteRow => {
      const q = getQuote(app, ctx.locationId, ctx.params.id);
      if (!q) throw notFound('Angebot nicht gefunden');
      denyUnless(permits(app, resolve(app, ctx), 'deals', q.deal_id));
      return q;
    };

    // --- lists --------------------------------------------------------------------------------------------------------------------
    const filters = (ctx: Ctx) => {
      const where = ['q.location_id = ?'];
      const params: any[] = [ctx.locationId];
      const scope = scopeClause(resolve(app, ctx), 'deals', 'o');
      if (scope) (where.push(scope.sql), params.push(...scope.params));
      const status = ctx.query.get('status');
      if (status && (QUOTE_STATUSES as readonly string[]).includes(status)) (where.push('q.status = ?'), params.push(status));
      for (const [key, col] of [['deal_id', 'q.deal_id'], ['contact_id', 'q.contact_id']] as const) {
        const v = ctx.query.get(key);
        if (v) (where.push(`${col} = ?`), params.push(v));
      }
      return { where, params, scope };
    };

    // The fixed path comes before ":id".
    router.get('/api/quotes/stats', 'location', (ctx) => {
      const { scope } = filters(ctx);
      return { ...quoteStats(app, ctx.locationId, scope), labels: QUOTE_STATUS_LABEL };
    });

    router.get('/api/quotes', 'location', (ctx) => {
      const { where, params } = filters(ctx);
      const rows = db.all<{ id: string }>(
        `SELECT q.id FROM deal_quotes q JOIN opportunities o ON o.id = q.deal_id WHERE ${where.join(' AND ')} ORDER BY q.updated_at DESC LIMIT ?`,
        ...params,
        clampLimit(ctx.query.get('limit'), 200, 500),
      );
      return rows.map((r) => {
        const q = getQuote(app, ctx.locationId, r.id)!;
        const o = quoteOut(app, q);
        return { id: q.id, number: q.number, title: q.title, status: q.status, status_label: o.status_label, currency: q.currency, valid_until: q.valid_until, revision: q.revision, sent_at: q.sent_at, accepted_at: q.accepted_at, expired: o.expired, deal: o.deal, contact: o.contact, total_cents: q.accepted_total_cents ?? o.totals.total_cents, net_cents: o.totals.net_cents, paid_at: q.paid_at, url: o.url, updated_at: q.updated_at };
      });
    });

    // --- one quote ------------------------------------------------------------------------------------------------------------------
    router.post('/api/quotes', 'location', (ctx) => {
      const b = ctx.body ?? {};
      const dealId = str(b.deal_id, 'Deal', { required: true, max: 64 });
      denyUnless(permits(app, resolve(app, ctx), 'deals', dealId));
      const q = asHttp(() => createQuote(app, ctx.locationId, dealId, { userId: ctx.user?.id ?? null, title: b.title, valid_days: b.valid_days, items: b.items, options: b.options }));
      const extra = ['intro', 'terms', 'payment', 'tax_mode', 'deal_on_accept', 'valid_until'].filter((k) => b[k] !== undefined);
      return quoteOut(app, extra.length ? updateQuote(app, ctx.locationId, q, Object.fromEntries(extra.map((k) => [k, b[k]]))) : q);
    });

    router.get('/api/quotes/:id', 'location', (ctx) => quoteOut(app, must(ctx)));

    router.patch('/api/quotes/:id', 'location', (ctx) => quoteOut(app, asHttp(() => updateQuote(app, ctx.locationId, must(ctx), ctx.body ?? {}))));

    router.delete('/api/quotes/:id', 'location', (ctx) => {
      const q = must(ctx);
      if (q.status !== 'draft') throw new HttpError(409, 'Nur Entwürfe lassen sich löschen – ein gesendetes Angebot zurückziehen');
      db.run('DELETE FROM deal_quotes WHERE id = ? AND location_id = ?', q.id, ctx.locationId);
      return { ok: true };
    });

    /** What the customer would see for a choice (the editor's preview of totals and of what is due). */
    router.post('/api/quotes/:id/preview', 'location', (ctx) => {
      const q = must(ctx);
      const sel = asHttp(() => resolveSelection(q.doc, ctx.body ?? {}));
      const t = quoteTotals(q.doc, sel, q.tax_mode);
      return { selection: sel, totals: { net_cents: t.subtotal_cents, tax_cents: t.tax_cents, total_cents: t.total_cents, discount_cents: t.discount_cents, list_cents: t.list_cents, groups: t.groups }, html: totalsHtml(q, sel) };
    });

    router.post('/api/quotes/:id/send', 'location', async (ctx) => {
      const q = must(ctx);
      const b = ctx.body ?? {};
      const r = await sendQuote(app, ctx.locationId, q, { userId: ctx.user?.id, channel: b.channel === 'sms' ? 'sms' : 'email', subject: b.subject, body: b.body, deliver: b.deliver !== false });
      return { ...quoteOut(app, r.quote), message: r.message };
    });

    router.post('/api/quotes/:id/void', 'location', (ctx) => quoteOut(app, voidQuote(app, ctx.locationId, must(ctx), str(ctx.body?.reason, 'Grund', { max: 300 }))));

    router.post('/api/quotes/:id/duplicate', 'location', (ctx) => quoteOut(app, duplicateQuote(app, ctx.locationId, must(ctx), ctx.user?.id ?? null)));

    /**
     * Accepted quote → invoice (the existing quote-to-invoice flow): the invoice draft for the whole order; after a deposit it is a
     * final invoice that deducts the deposit invoice. Returns the invoice draft – finalising and sending are the invoicing page's.
     */
    router.post('/api/quotes/:id/invoice', 'location', (ctx) => {
      const q = must(ctx);
      if (q.status !== 'accepted' || !q.estimate_id) throw new HttpError(409, 'Nur ein angenommenes Angebot lässt sich in eine Rechnung umwandeln');
      if (q.final_invoice_id) throw new HttpError(409, 'Aus diesem Angebot gibt es schon eine Rechnung');
      if (q.invoice_kind === 'standard') throw new HttpError(409, 'Die Rechnung zu diesem Angebot wurde schon bei der Annahme erstellt');
      const partial = q.invoice_kind === 'partial' && q.invoice_id;
      const actor = ctx.user ? { id: ctx.user.id, name: ctx.user.name } : SYSTEM;
      const inv = convertEstimate(app, ctx.locationId, q.estimate_id, actor, { inv_type: partial ? 'final' : 'standard' });
      if (partial) db.run('UPDATE invoices SET deduct_ids = ? WHERE id = ?', JSON.stringify([q.invoice_id]), inv.id);
      db.run('UPDATE deal_quotes SET final_invoice_id = ?, updated_at = ? WHERE id = ?', inv.id, now(), q.id);
      return { invoice_id: inv.id, kind: partial ? 'final' : 'standard', invoice: mustInvoice(app, ctx.locationId, inv.id).id, quote: quoteOut(app, getQuote(app, ctx.locationId, q.id)!) };
    });

    // --- the customer's page ---------------------------------------------------------------------------------------------------------
    const hits = new Map<string, number[]>();
    const throttled = (ip: string, per = 60) => {
      const t = Date.now();
      const list = (hits.get(ip) ?? []).filter((x) => t - x < 60_000);
      list.push(t);
      hits.set(ip, list);
      if (hits.size > 5000) hits.clear();
      return list.length > per;
    };
    const open = (tok: string): QuoteRow => {
      const q = quoteByToken(app, tok);
      if (!q || q.status === 'draft') throw notFound();
      return q;
    };

    router.get('/q/:token', 'public', (ctx) => {
      const q = quoteByToken(app, ctx.params.token);
      if (!q || q.status === 'draft') return html(messagePage('Nicht gefunden', 'Dieses Angebot gibt es nicht.'), 404);
      if (throttled(ctx.ip, 120)) return html(messagePage('Bitte kurz warten', 'Zu viele Aufrufe – bitte in einer Minute noch einmal.'), 429);
      markViewed(app, q);
      return { __raw: true, status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' }, body: quoteHtml(app, getQuote(app, q.location_id, q.id)!) };
    });

    router.post('/api/public/quotes/:token/preview', 'public', (ctx) => {
      const q = open(ctx.params.token);
      if (throttled(ctx.ip, 240)) throw new HttpError(429, 'Zu viele Anfragen');
      const sel = asHttp(() => resolveSelection(q.doc, ctx.body ?? {}));
      return { html: totalsHtml(q, sel) };
    });

    router.post('/api/public/quotes/:token/accept', 'public', async (ctx) => {
      if (throttled(`${ctx.ip}|${ctx.params.token}`, 20)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
      const b = ctx.body ?? {};
      const r = await acceptQuote(app, ctx.params.token, {
        option_id: b.option_id,
        optional_ids: b.optional_ids,
        name: String(b.name ?? ''),
        signature: String(b.signature ?? ''),
        agree: b.agree === true,
        ip: ctx.ip,
        userAgent: String(ctx.req.headers['user-agent'] ?? ''),
      });
      return { ok: true, invoice: r.invoice ? { url: r.invoice.url, kind: r.invoice.kind, total_cents: r.invoice.total_cents } : null };
    });

    router.post('/api/public/quotes/:token/decline', 'public', (ctx) => {
      if (throttled(`${ctx.ip}|${ctx.params.token}`, 20)) throw new HttpError(429, 'Zu viele Versuche – bitte kurz warten');
      declineQuote(app, open(ctx.params.token), str(ctx.body?.reason, 'Grund', { max: 1000 }));
      return { ok: true };
    });
  },
};
