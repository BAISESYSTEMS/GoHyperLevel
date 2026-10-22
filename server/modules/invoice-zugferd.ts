import type { App, Module } from '../core/app.js';
import { bad, type RawResult } from '../core/http.js';
import { actorOf, invAudit, mustInvoice, type Actor, type Inv } from '../services/invoice-flow.js';
import { archiveFile } from '../services/invoice-render.js';
import { zugferdOf, type ZugferdOut } from '../services/invoice-zugferd.js';
import { FX_PROFILES, isFxProfile, type FxProfile } from '../services/zugferd-pdf.js';
import type { Tool } from './mcp.js';

/**
 * ZUGFeRD 2.3 / Factur-X 1.07 for the GoBD invoicing: the download route next to the XRechnung (archived immutably like it),
 * the MCP tool ghl_invoice_zugferd, and – when the sub-account sets `invoices.attach_zugferd` – the hybrid PDF instead of
 * the plain PDF in the invoice mail (through app.services.invoiceMailPdf, which payments.ts asks before it renders the PDF).
 */

const profileOf = (v: string | null): FxProfile => {
  if (!v) return 'en16931';
  if (!isFxProfile(v)) throw bad('Profil: en16931 oder xrechnung');
  return v;
};

/** Writes the file into the invoice archive (identical bytes once) and notes it in the invoice trail. */
function archive(app: App, inv: Inv, out: ZugferdOut, actor: Actor) {
  const doc = archiveFile(app, inv, 'zugferd', { name: out.filename, mime: 'application/pdf', data: out.pdf }, actor);
  if (!doc.duplicate) invAudit(app, inv.location_id, inv.id, 'zugferd.generated', `ZUGFeRD 2.3 / Factur-X ${FX_PROFILES[out.profile].conformance} · SHA-256 ${doc.sha256.slice(0, 16)}… · Aufbewahrung bis ${doc.retention_until}`, actor);
  return doc;
}

const TOOL: Tool = {
  name: 'ghl_invoice_zugferd',
  title: 'ZUGFeRD-Rechnung (PDF mit XML) erzeugen',
  description:
    'Erzeugt die ZUGFeRD 2.3 / Factur-X 1.07 einer festgeschriebenen Rechnung oder Gutschrift: das Rechnungs-PDF mit eingebetteter CII-XML (factur-x.xml, Profil EN 16931; profile xrechnung bettet die XRechnung als xrechnung.xml ein), prüft die XML gegen die eigenen EN-16931-Regeln und archiviert die Datei unveränderlich (SHA-256, 8 Jahre). Antwort: Dateiname, Prüfsumme, die eingebettete XML und der Download-Pfad; include_pdf=true liefert das PDF zusätzlich als Base64. Fehlen Angaben (z. B. Telefonnummer des Absenders, IBAN), kommt eine verständliche Fehlermeldung.',
  inputSchema: {
    type: 'object',
    properties: {
      location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' },
      invoice_id: { type: 'string', description: 'ID der Rechnung (aus ghl_list_invoices)' },
      profile: { type: 'string', enum: ['en16931', 'xrechnung'], description: 'Standard: en16931' },
      include_pdf: { type: 'boolean', description: 'PDF als Base64 mitliefern (Standard: nein)' },
    },
    required: ['invoice_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  run: (call, a) => call.api('GET', `/api/invoices/${encodeURIComponent(a.invoice_id)}/zugferd?format=json&profile=${a.profile === 'xrechnung' ? 'xrechnung' : 'en16931'}${a.include_pdf ? '&include_pdf=1' : ''}`, { location: a.location_id }),
};

export const invoiceZugferdModule: Module = {
  name: 'invoice-zugferd',
  register(app) {
    app.router.get('/api/invoices/:id/zugferd', 'location', (ctx) => {
      const inv = mustInvoice(app, ctx.locationId, ctx.params.id);
      const profile = profileOf(ctx.query.get('profile'));
      const out = zugferdOf(app, inv, profile);
      const doc = archive(app, inv, out, actorOf(ctx));
      if (ctx.query.get('format') === 'json') {
        return {
          filename: out.filename,
          profile,
          conformance: FX_PROFILES[profile].conformance,
          embedded: out.embedded,
          xml: out.xml,
          sha256: doc.sha256,
          size: out.pdf.length,
          retention_until: doc.retention_until,
          download: `/api/invoices/${inv.id}/zugferd?profile=${profile}&download=1`,
          validation: { valid: out.validation.valid, errors: out.validation.errors, warnings: out.validation.warnings },
          ...(ctx.query.get('include_pdf') === '1' ? { pdf_base64: out.pdf.toString('base64') } : {}),
        };
      }
      const res: RawResult = {
        __raw: true,
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': `${ctx.query.get('download') === '1' ? 'attachment' : 'inline'}; filename="${out.filename}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
        body: out.pdf,
      };
      return res;
    });

    // The invoice mail: the hybrid PDF instead of the plain one when the setting (or the send request) asks for it.
    // A configured default falls back to the plain PDF when the e-invoice cannot be made; an explicit request refuses.
    app.services.invoiceMailPdf = (inv: Inv, o: { actor: Actor; wanted?: boolean }): { pdf: Buffer; filename: string } | null => {
      const cfg = app.location(inv.location_id)?.settings.invoices ?? {};
      if (!(o.wanted ?? !!cfg.attach_zugferd) || inv.kind === 'estimate' || !inv.finalised_at) return null;
      try {
        const out = zugferdOf(app, inv, 'en16931');
        archive(app, inv, out, o.actor);
        return { pdf: out.pdf, filename: out.filename };
      } catch (e) {
        if (o.wanted) throw e;
        invAudit(app, inv.location_id, inv.id, 'zugferd.attach_skipped', (e as Error).message.slice(0, 300), o.actor);
        return null;
      }
    };

    app.services.mcpTools = [...(app.services.mcpTools ?? []), TOOL];
  },
};
