import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { bad, notFound, str } from '../core/http.js';
import { now } from '../core/util.js';
import type { Tool } from './mcp.js';

/**
 * Links invoices to the accounting system that issues the legally binding copy (Norman Finance,
 * Lexware, …): number, status and link come back here, so the CRM shows what the books say.
 * The hand-over itself runs through MCP (Claude reads unsynced invoices here, creates them in
 * Norman via Norman's MCP and writes the result back with ghl_link_invoice).
 */

export const PROVIDERS = ['norman', 'lexware', 'sevdesk', 'other'];
const STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];

const TOOLS: Tool[] = [
  {
    name: 'ghl_list_invoices',
    title: 'Rechnungen auflisten',
    description:
      'Rechnungen mit Kontakt, Positionen und Buchhaltungs-Verknüpfung. Agentur: alle Projekte, unsynced=true nur die noch nicht an Norman/Buchhaltung übergebenen (Status gesendet oder bezahlt). Mit location_id nur ein Projekt.',
    inputSchema: { type: 'object', properties: { location_id: { type: 'string' }, unsynced: { type: 'boolean' }, status: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: (call, a) =>
      call.agency
        ? call.api('GET', `/api/agency/invoices?${new URLSearchParams({ ...(a.location_id ? { location_id: a.location_id } : {}), ...(a.unsynced ? { unsynced: '1' } : {}), ...(a.status ? { status: a.status } : {}) })}`)
        : call.api('GET', '/api/invoices'),
  },
  {
    name: 'ghl_link_invoice',
    title: 'Rechnung mit Buchhaltung verknüpfen',
    description:
      'Speichert, wo die Rechnung in der Buchhaltung liegt: provider (norman|lexware|sevdesk|other), external_id, number (Rechnungsnummer dort), status (draft|sent|paid|overdue|cancelled), url. Nach dem Anlegen in Norman aufrufen und bei Statuswechsel (z. B. bezahlt) aktualisieren.',
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'string' },
        invoice_id: { type: 'string' },
        provider: { type: 'string', enum: PROVIDERS },
        external_id: { type: 'string' },
        number: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        url: { type: 'string' },
      },
      required: ['invoice_id', 'provider'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (call, a) => {
      const { location_id, invoice_id, ...body } = a;
      return call.api('PUT', `/api/invoices/${encodeURIComponent(invoice_id)}/external`, { location: location_id, body });
    },
  },
];

export const invoiceLinksModule: Module = {
  name: 'invoice-links',
  migrations: [
    [
      '001-init',
      `
      CREATE TABLE invoice_links (
        invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE, location_id TEXT NOT NULL,
        provider TEXT NOT NULL, external_id TEXT NOT NULL DEFAULT '', number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', synced_at TEXT NOT NULL
      );
      CREATE INDEX invoice_links_location ON invoice_links(location_id);
      `,
    ],
  ],
  register(app) {
    const { db, router } = app;
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...TOOLS];

    router.get('/api/invoice-links', 'location', (ctx) => db.all('SELECT * FROM invoice_links WHERE location_id = ?', ctx.locationId));
    router.put('/api/invoices/:id/external', 'location', (ctx) => {
      const inv = db.get('SELECT id FROM invoices WHERE id = ? AND location_id = ?', ctx.params.id, ctx.locationId);
      if (!inv) throw notFound();
      const b = ctx.body ?? {};
      if (!PROVIDERS.includes(b.provider)) throw bad('provider: norman, lexware, sevdesk oder other');
      if (b.status && !STATUSES.includes(b.status)) throw bad('Unbekannter Status');
      const url = str(b.url, 'Link', { max: 500 });
      if (url && !/^https:\/\//i.test(url)) throw bad('Link: bitte mit https:// angeben');
      const row = {
        invoice_id: inv.id,
        location_id: ctx.locationId,
        provider: b.provider,
        external_id: str(b.external_id, 'Externe ID', { max: 200 }),
        number: str(b.number, 'Rechnungsnummer', { max: 100 }),
        status: b.status ?? '',
        url,
        synced_at: now(),
      };
      db.run(
        `INSERT INTO invoice_links (invoice_id, location_id, provider, external_id, number, status, url, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(invoice_id) DO UPDATE SET provider = excluded.provider, external_id = excluded.external_id, number = excluded.number, status = excluded.status, url = excluded.url, synced_at = excluded.synced_at`,
        ...Object.values(row),
      );
      // Paid in the books means paid here too.
      if (row.status === 'paid') db.run(`UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ? AND status != 'paid'`, now(), now(), inv.id);
      return row;
    });
    router.delete('/api/invoices/:id/external', 'location', (ctx) => {
      if (!db.run('DELETE FROM invoice_links WHERE invoice_id = ? AND location_id = ?', ctx.params.id, ctx.locationId).changes) throw notFound();
      return { ok: true };
    });

    router.get('/api/agency/invoices', 'admin', (ctx) => {
      const where = [`i.kind = 'invoice'`];
      const params: any[] = [];
      const loc = ctx.query.get('location_id');
      if (loc) (where.push('i.location_id = ?'), params.push(loc));
      const status = ctx.query.get('status');
      if (status) (where.push('i.status = ?'), params.push(status));
      if (ctx.query.get('unsynced')) where.push(`l.invoice_id IS NULL AND i.status IN ('sent', 'paid')`);
      return parseRows(
        db.all(
          `SELECT i.id, i.location_id, p.name AS project, i.number, i.title, i.items, i.currency, i.subtotal_cents, i.tax_cents, i.total_cents, i.status,
                  i.issued_at, i.due_at, i.paid_at, i.notes, i.finalised_at, i.doc_hash, i.paid_cents, i.tax_mode, c.first_name, c.last_name, c.email, c.company, c.address, c.city, c.postal_code, c.country,
                  l.provider AS ext_provider, l.number AS ext_number, l.status AS ext_status, l.url AS ext_url, l.synced_at AS ext_synced_at
           FROM invoices i JOIN locations p ON p.id = i.location_id LEFT JOIN contacts c ON c.id = i.contact_id LEFT JOIN invoice_links l ON l.invoice_id = i.id
           WHERE ${where.join(' AND ')} ORDER BY i.issued_at DESC LIMIT 1000`,
          ...params,
        ),
        ['items'],
      );
    });
  },
};
