import type { App, Module } from '../core/app.js';
import { notFound } from '../core/http.js';
import { formatInTz } from '../core/time.js';
import { A4, Page, latin, pdfOf } from '../services/creator-pdf.js';
import type { Tool } from './mcp.js';
import { mappingSummary } from './form-mapping.js';

/**
 * PDF of a form submission (HighLevel parity, docs/forms.md#pdf-of-a-submission): the answers as an A4 document – form name, date,
 * contact, every question with its answer (files as their links), source and points/result when the form has them – built with the
 * server's own PDF writer like invoices and wiki pages. `GET /api/forms/:id/submissions/:sid/pdf` (area forms). MCP: the agent reads
 * forms and answers through `ghl_forms` and `ghl_form_submissions` (read only); the PDF is for people.
 */

type Row = { id: string; form_id: string; location_id: string; contact_id: string | null; data: string; meta: string; created_at: string };

const parse = (v: string) => {
  try {
    const x = JSON.parse(v);
    return x && typeof x === 'object' ? x : {};
  } catch {
    return {};
  }
};
const answerText = (v: unknown): string => (Array.isArray(v) ? v.map(String).join(', ') : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function submissionPdf(app: App, sub: Row): Buffer {
  const form = app.db.get<{ name: string }>('SELECT name FROM forms WHERE id = ?', sub.form_id);
  const loc = app.location(sub.location_id)!;
  const contact = sub.contact_id ? app.db.get<any>('SELECT first_name, last_name, email, phone FROM contacts WHERE id = ?', sub.contact_id) : undefined;
  const data = parse(sub.data) as Record<string, unknown>;
  const meta = parse(sub.meta) as Record<string, unknown>;
  const L = 60;
  const W = A4.w - 120;
  const pages: Page[] = [];
  let page = new Page();
  let y = 0;
  const fresh = () => {
    page = new Page();
    pages.push(page);
    page.rect(0, 0, A4.w, 8, { fill: '#1e3a8a' });
    page.text(A4.w - 60, A4.h - 40, latin(`${loc.name} · ${form?.name ?? 'Formular'} · Seite ${pages.length}`), 8.5, { color: '#94a3b8', anchor: 'end' });
    y = 52;
  };
  const lines = (s: string, size: number) => Math.max(1, s.split('\n').reduce((n, part) => n + Math.ceil(Math.max(1, part.length) / Math.max(12, Math.floor(W / (size * 0.52)))), 0));
  const block = (label: string, value: string) => {
    const v = latin(value || '–');
    const need = 16 + lines(v, 10.5) * 10.5 * 1.4 + 10;
    if (y + need > A4.h - 70) fresh();
    y += page.para(L, y, latin(label), W, 9.5, { bold: true, color: '#475569' });
    y += page.para(L, y + 2, v, W, 10.5) + 10;
    page.line(L, y - 5, L + W, y - 5, { stroke: '#e2e8f0' });
  };
  fresh();
  page.text(L, y, latin(form?.name ?? 'Formular'), 19, { bold: true, color: '#1e3a8a' });
  y += 30;
  const who = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email : '';
  const head = [`Eingegangen am ${formatInTz(sub.created_at, loc.timezone, { weekday: undefined })} Uhr`, who ? `Kontakt: ${who}${contact?.email && who !== contact.email ? ` (${contact.email})` : ''}` : '', `Einsendung ${sub.id}`].filter(Boolean).join('\n');
  y += page.para(L, y, latin(head), W, 10, { color: '#64748b' }) + 14;
  for (const [k, v] of Object.entries(data)) block(k, answerText(v));
  const extra: [string, unknown][] = [
    ['Punkte', meta.score],
    ['Ergebnis', meta.result],
    ['Seite', meta.page],
    ['Quelle', [meta.utm_source, meta.utm_campaign].filter(Boolean).join(' / ')],
  ];
  for (const [k, v] of extra) if (v !== undefined && v !== null && v !== '') block(k, answerText(v));
  return pdfOf(pages, { title: `${form?.name ?? 'Formular'} – Einsendung` });
}


const LOC = { location_id: { type: 'string', description: 'Sub-Account/Projekt-ID (aus ghl_list_projects)' } };
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const RO = { readOnlyHint: true, openWorldHint: false };

export const FORM_TOOLS: Tool[] = [
  {
    name: 'ghl_forms',
    title: 'Formulare und Umfragen',
    description: 'Die Formulare/Umfragen eines Sub-Accounts mit Anzahl der Einsendungen und öffentlichem Link.',
    inputSchema: obj({ ...LOC }, ['location_id']),
    annotations: RO,
    run: async (call, a) => {
      const list = await call.api('GET', '/api/forms', { location: a.location_id });
      return (Array.isArray(list) ? list : []).map((f: any) => ({ id: f.id, name: f.name, submissions: f.submissions, url: f.url, link: `/app/forms/${f.id}`, mapping: mappingSummary(f.settings) }));
    },
  },
  {
    name: 'ghl_form_submission_pdfs',
    title: 'Einsendungen eines Formulars mit PDF-Link',
    description: 'Die letzten Einsendungen eines Formulars (neueste zuerst) mit Kontakt, Antworten (Frage → Antwort) und dem Link zum PDF der Einsendung (pdf_url, für Menschen in der App).',
    inputSchema: obj({ ...LOC, form_id: { type: 'string', description: 'Formular-ID (aus ghl_forms)' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Anzahl, Standard 20' } }, ['location_id', 'form_id']),
    annotations: RO,
    run: async (call, a) => {
      const list = await call.api('GET', `/api/forms/${encodeURIComponent(a.form_id)}/submissions`, { location: a.location_id });
      return (Array.isArray(list) ? list : []).slice(0, Math.min(Math.max(Number(a.limit) || 20, 1), 100)).map((s: any) => ({
        id: s.id,
        created_at: s.created_at,
        contact_id: s.contact_id,
        contact: [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email || null,
        answers: s.data,
        pdf_url: `/api/forms/${s.form_id}/submissions/${s.id}/pdf`,
      }));
    },
  },
];

export const formPdfModule: Module = {
  name: 'form-pdf',
  register(app) {
    app.services.mcpTools = [...(app.services.mcpTools ?? []), ...FORM_TOOLS];
    app.router.get('/api/forms/:id/submissions/:sid/pdf', 'location', (ctx) => {
      const sub = app.db.get<Row>('SELECT * FROM form_submissions WHERE id = ? AND form_id = ? AND location_id = ?', ctx.params.sid, ctx.params.id, ctx.locationId);
      if (!sub) throw notFound('Einsendung nicht gefunden');
      const day = sub.created_at.slice(0, 10);
      return {
        __raw: true,
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="einsendung-${day}-${sub.id.slice(0, 8)}.pdf"`, 'cache-control': 'private, no-store' },
        body: submissionPdf(app, sub),
      };
    });
    app.router.get('/api/forms/:id/submissions/:sid', 'location', (ctx) => {
      const sub = app.db.get<Row>('SELECT * FROM form_submissions WHERE id = ? AND form_id = ? AND location_id = ?', ctx.params.sid, ctx.params.id, ctx.locationId);
      if (!sub) throw notFound('Einsendung nicht gefunden');
      return { ...sub, data: parse(sub.data), meta: parse(sub.meta), pdf_url: `/api/forms/${sub.form_id}/submissions/${sub.id}/pdf` };
    });
  },
};
