import type { Module } from '../core/app.js';
import type { Tool } from './mcp.js';

/**
 * MCP tools for the GoBD invoicing (finalise, cancel with a Stornorechnung, credit notes, payments, XRechnung): thin relays onto
 * the invoice routes, so rights, rules (409 on frozen invoices) and the audit trail are the same as in the app.
 * The existing tools ghl_list_invoices / ghl_link_invoice live in invoice-links.ts.
 */

const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const ID = { invoice_id: { type: 'string', description: 'ID der Rechnung (aus ghl_list_invoices)' } };
const ITEM = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: 'string' }, qty: { type: 'number' }, price_cents: { type: 'integer', description: 'Netto je Einheit in Cent' }, tax_rate: { type: 'number', description: 'USt in Prozent (bei Kleinunternehmer/Reverse Charge 0)' } },
  required: ['name', 'price_cents'],
  additionalProperties: false,
};
const path = (id: string, tail = '') => `/api/invoices/${encodeURIComponent(id)}${tail}`;

const TOOLS: Tool[] = [
  {
    name: 'ghl_invoice_finalise',
    title: 'Rechnung festschreiben',
    description:
      'Schreibt einen Rechnungsentwurf fest (GoBD): vergibt die nächste fortlaufende Nummer ohne Lücken, friert Positionen, Beträge und Kundendaten ein und speichert Momentaufnahme + SHA-256. Danach sind nur noch Hinweistext und Fälligkeit änderbar; eine Korrektur geht nur per Stornorechnung (ghl_invoice_cancel). Prüft Pflichtangaben (z. B. Reverse Charge braucht beide USt-IdNr. und den Hinweistext). Optional invoice_date (ISO).',
    inputSchema: { type: 'object', properties: { ...LOC, ...ID, invoice_date: { type: 'string', description: 'Rechnungsdatum (ISO); Standard: heute' } }, required: ['invoice_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', path(a.invoice_id, '/finalise'), { location: a.location_id, body: a.invoice_date ? { issued_at: a.invoice_date } : {} }),
  },
  {
    name: 'ghl_invoice_cancel',
    title: 'Rechnung stornieren (Stornorechnung)',
    description:
      'Storniert eine festgeschriebene Rechnung: erzeugt eine Stornorechnung mit eigener Nummer, Verweis auf die Rechnung und negativen Beträgen; die Rechnung gilt als storniert, die Buchhaltung wird gegengebucht. Unwiderruflich – eine Rechnung wird nie „zurückgesetzt“. Entwürfe werden stattdessen gelöscht. Gibt es schon Gutschriften zur Rechnung, wird die Stornierung abgelehnt (sie würde mehr erstatten, als die Rechnung wert ist) – dann ghl_invoice_credit_note mit remainder=true. Optional reason (Grund, steht auf dem Beleg).',
    inputSchema: { type: 'object', properties: { ...LOC, ...ID, reason: { type: 'string', description: 'Grund der Stornierung (max. 300 Zeichen)' } }, required: ['invoice_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', path(a.invoice_id, '/storno'), { location: a.location_id, body: { reason: a.reason } }),
  },
  {
    name: 'ghl_invoice_credit_note',
    title: 'Gutschrift / Rechnungskorrektur erstellen',
    description:
      'Erstellt eine Teil-Gutschrift (Rechnungskorrektur) zu einer festgeschriebenen Rechnung. items positiv angeben (Menge × Preis netto, gutzuschreibender Betrag) – gespeichert wird negativ, mit Verweis auf die Rechnung. Standard: Entwurf; mit finalise=true gleich festschreiben (Nummer, Buchung). Die Summe aller Gutschriften darf die Rechnung nicht übersteigen. remainder=true statt items: „Restbetrag gutschreiben“ – je Steuersatz das, was noch nicht gutgeschrieben ist (so wird der Rest einer Rechnung mit Gutschriften aufgehoben; eine Stornorechnung ist dann nicht mehr möglich).',
    inputSchema: {
      type: 'object',
      properties: {
        ...LOC,
        ...ID,
        items: { type: 'array', items: ITEM, minItems: 1 },
        remainder: { type: 'boolean', description: 'Den ganzen noch nicht gutgeschriebenen Rest gutschreiben (statt items)' },
        reason: { type: 'string' },
        finalise: { type: 'boolean', description: 'Gleich festschreiben (Standard: nein, Entwurf)' },
      },
      required: ['invoice_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    klassFor: (a) => (a.finalise ? 'sensitive' : 'write'),
    run: async (call, a) => {
      const draft = await call.api('POST', path(a.invoice_id, '/credit-note'), { location: a.location_id, body: a.remainder ? { remainder: true, reason: a.reason } : { items: a.items, reason: a.reason } });
      return a.finalise ? call.api('POST', path(draft.id, '/finalise'), { location: a.location_id, body: {} }) : draft;
    },
  },
  {
    name: 'ghl_invoice_record_payment',
    title: 'Zahlung (auch Teilzahlung) erfassen',
    description: 'Erfasst einen Zahlungseingang auf einer festgeschriebenen Rechnung. Ohne amount_cents wird der offene Betrag bezahlt. Teilzahlungen lassen die Rechnung „teilweise bezahlt“; bei 0 offen ist sie bezahlt (invoice.paid). skonto=true: der Kunde hat Skonto abgezogen – der Rest bis zum offenen Betrag gilt als Skonto (nur innerhalb der Frist und bis zum vereinbarten Prozentsatz).',
    inputSchema: { type: 'object', properties: { ...LOC, ...ID, amount_cents: { type: 'integer' }, paid_at: { type: 'string', description: 'ISO-Datum der Zahlung' }, method: { type: 'string' }, note: { type: 'string' }, skonto: { type: 'boolean' } }, required: ['invoice_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (call, a) => {
      const { location_id, invoice_id, ...body } = a;
      return call.api('POST', path(invoice_id, '/payments'), { location: location_id, body });
    },
  },
  {
    name: 'ghl_invoice_xrechnung',
    title: 'XRechnung (E-Rechnung) erzeugen',
    description:
      'Erzeugt die XRechnung 3.0 (EN 16931) einer festgeschriebenen Rechnung oder Gutschrift als XML – syntax cii (UN/CEFACT, Standard) oder ubl (UBL 2.1) – prüft sie gegen die eigenen EN-16931-Regeln und archiviert sie unveränderlich (SHA-256, Aufbewahrung 8 Jahre). Fehlen Angaben (z. B. Telefonnummer des Absenders, IBAN, Kunden-Anschrift/E-Mail), kommt eine verständliche Fehlermeldung. Kein Ersatz für den offiziellen KoSIT-Validator vor dem ersten produktiven Versand.',
    inputSchema: { type: 'object', properties: { ...LOC, ...ID, syntax: { type: 'string', enum: ['cii', 'ubl'] } }, required: ['invoice_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => call.api('GET', `${path(a.invoice_id, '/xrechnung')}?format=json&syntax=${a.syntax === 'ubl' ? 'ubl' : 'cii'}`, { location: a.location_id }),
  },
  {
    name: 'ghl_quote_to_invoice',
    title: 'Angebot in Rechnung umwandeln',
    description: 'Macht aus einem versendeten oder angenommenen Angebot einen Rechnungsentwurf mit Verweis auf das Angebot (Positionen, Kunde, Hinweise werden übernommen). inv_type: standard, partial (Abschlagsrechnung) oder final (Schlussrechnung). Der Entwurf hat noch keine Nummer – ghl_invoice_finalise schreibt ihn fest.',
    inputSchema: { type: 'object', properties: { ...LOC, quote_id: { type: 'string' }, inv_type: { type: 'string', enum: ['standard', 'partial', 'final'] } }, required: ['quote_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (call, a) => call.api('POST', path(a.quote_id, '/convert'), { location: a.location_id, body: { inv_type: a.inv_type } }),
  },
];

export const invoiceToolsModule: Module = {
  name: 'invoice-tools',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];
  },
};
