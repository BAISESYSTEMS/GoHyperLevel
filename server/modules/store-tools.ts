import type { Module } from '../core/app.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools of the online store and gift cards (docs/store.md#mcp-tools) – thin relays onto /api/store and /api/gift-cards, so rights,
 * sub-account scope and the audit log are the same as in the app.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };

const TOOLS: Tool[] = [
  {
    name: 'ghl_store_orders',
    title: 'Shop-Bestellungen auflisten',
    description:
      'Bestellungen des Online-Shops, neueste zuerst: Nummer, Käufer, Positionen, Summe, Zahlungsstatus (pending, paid, cancelled, refunded), Versandstatus (unfulfilled, processing, shipped, delivered, cancelled), Sendungsnummer, Rechnung. Filter: status, fulfilment ("open" = bezahlt und noch nicht versendet), q (Nummer, E-Mail, Name, Sendungsnummer), limit.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        status: { type: 'string', enum: ['pending', 'paid', 'cancelled', 'refunded'] },
        fulfilment: { type: 'string', enum: ['open', 'unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'] },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => {
      const qs = new URLSearchParams();
      for (const k of ['status', 'fulfilment', 'q', 'limit']) if (a[k] !== undefined && a[k] !== '') qs.set(k, String(a[k]));
      return call.api('GET', `/api/store/orders${qs.size ? `?${qs}` : ''}`, { location: a.location_id });
    },
  },
  {
    name: 'ghl_store_order_status',
    title: 'Shop-Bestellung: Status ansehen oder setzen',
    description:
      'Ohne Änderungsfelder: eine Bestellung mit Zahlung, Rechnung, Versand und verkauften Gutscheinen. Mit fulfilment (processing, shipped, delivered, cancelled), carrier (dhl, dpd, hermes, gls, ups, post_at, other) und/oder tracking_number: setzt den Versandstatus – „shipped“ schickt dem Käufer die Versand-Mail mit Sendungsverfolgung (notify=false: ohne Mail) und startet den Auslöser „Shop: Bestellung versendet“.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        order_id: { type: 'string', description: 'ID der Bestellung (aus ghl_store_orders)' },
        fulfilment: { type: 'string', enum: ['processing', 'shipped', 'delivered', 'cancelled'] },
        carrier: { type: 'string', enum: ['dhl', 'dpd', 'hermes', 'gls', 'ups', 'post_at', 'other'] },
        tracking_number: { type: 'string' },
        notify: { type: 'boolean' },
      },
      required: ['order_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (call, a) => {
      const path = `/api/store/orders/${encodeURIComponent(String(a.order_id))}`;
      const body: Record<string, unknown> = {};
      for (const k of ['fulfilment', 'carrier', 'tracking_number', 'notify']) if (a[k] !== undefined) body[k] = a[k];
      return Object.keys(body).length ? call.api('PATCH', path, { location: a.location_id, body }) : call.api('GET', path, { location: a.location_id });
    },
  },
  {
    name: 'ghl_gift_card_create',
    title: 'Gutschein ausstellen',
    description:
      'Stellt einen Gutschein (Mehrzweck-Gutschein) mit Code und Guthaben aus: amount_cents (mindestens 100), optional expires_at (Datum, leer = unbegrenzt gültig), contact_id (Käufer/Inhaber), recipient_name/recipient_email/message (Beschenkte:r), note. send=true schickt den Code per E-Mail (an recipient_email, sonst an den Kontakt). Einlösbar im Online-Shop, auf Rechnungen und bei Terminbuchungen.',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        amount_cents: { type: 'integer', minimum: 100 },
        expires_at: { type: 'string', description: 'YYYY-MM-DD, leer = ohne Ablauf' },
        contact_id: { type: 'string' },
        recipient_name: { type: 'string' },
        recipient_email: { type: 'string' },
        message: { type: 'string' },
        note: { type: 'string' },
        send: { type: 'boolean' },
      },
      required: ['amount_cents'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (call, a) => {
      const { location_id, ...body } = a;
      return call.api('POST', '/api/gift-cards', { location: location_id, body });
    },
  },
];

export const storeToolsModule: Module = {
  name: 'store-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
