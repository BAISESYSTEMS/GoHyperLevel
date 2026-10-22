import type { Caller } from '../modules/mcp.js';

/**
 * "Das hier" for the HyperLevel Agent (docs/agent.md#open-the-agent): which record an app route like `contacts/<id>` or
 * `workflows/<id>` names, how to load it with the user's rights and how to label it. One table for the context chip
 * (GET /api/agent/context), the context line of every chat message and the `ui_context` tool – so asking the agent works the
 * same from every record page, also from the companion in focus mode (it sends the page it was opened from).
 */

export interface RecordKind {
  type: string;
  label: string;
  path: (id: string) => string;
  name: (r: any) => string;
}

const person = (r: any) => r?.name || [r?.first_name, r?.last_name].filter(Boolean).join(' ') || r?.email || '';

/** First route segment → record kind. Pages whose second segment is a tab, not an id, stay out (or list their tabs below). */
export const RECORD_KINDS: Record<string, RecordKind> = {
  contacts: { type: 'contact', label: 'Kontakt', path: (id) => `/api/contacts/${id}`, name: (r) => person(r) || 'Kontakt' },
  companies: { type: 'company', label: 'Firma', path: (id) => `/api/companies/${id}`, name: (r) => r?.name || 'Firma' },
  conversations: { type: 'conversation', label: 'Konversation', path: (id) => `/api/conversations/${id}/messages`, name: (r) => person(r?.contact) || 'Konversation' },
  tickets: { type: 'ticket', label: 'Ticket', path: (id) => `/api/tickets/${id}`, name: (r) => `#${r?.number ?? ''} ${r?.subject ?? ''}`.trim() },
  invoices: { type: 'invoice', label: 'Rechnung', path: (id) => `/api/invoices/${id}`, name: (r) => r?.number || r?.title || 'Rechnung' },
  canvas: { type: 'canvas', label: 'Board', path: (id) => `/api/canvas/${id}`, name: (r) => r?.board?.name || r?.name || 'Board' },
  wiki: { type: 'wiki_page', label: 'Wiki-Seite', path: (id) => `/api/wiki/pages/${id}`, name: (r) => r?.title || 'Wiki-Seite' },
  forms: { type: 'form', label: 'Formular', path: (id) => `/api/forms/${id}`, name: (r) => r?.name || 'Formular' },
  funnels: { type: 'funnel', label: 'Funnel', path: (id) => `/api/funnels/${id}`, name: (r) => r?.name || r?.funnel?.name || 'Funnel' },
  workflows: { type: 'workflow', label: 'Automation', path: (id) => `/api/workflows/${id}`, name: (r) => r?.name || 'Automation' },
  courses: { type: 'course', label: 'Kurs', path: (id) => `/api/courses/${id}`, name: (r) => r?.title || r?.name || r?.course?.title || 'Kurs' },
  campaigns: { type: 'campaign', label: 'Kampagne', path: (id) => `/api/campaigns/${id}`, name: (r) => r?.name || 'Kampagne' },
  contracts: { type: 'contract', label: 'Vertrag', path: (id) => `/api/contracts/${id}`, name: (r) => r?.title || r?.name || 'Vertrag' },
  webinars: { type: 'webinar', label: 'Webinar', path: (id) => `/api/webinars/${id}`, name: (r) => r?.title || r?.name || r?.webinar?.title || 'Webinar' },
};

/** Second segments that are tabs of a list page, not record ids. */
const TABS: Record<string, string[]> = {
  campaigns: ['segments', 'gallery', 'templates', 'deliverability', 'links'],
  tickets: ['uebersicht', 'auslastung'],
};

/** The record a route names, or null: `contacts/abc` → { page: 'contacts', id: 'abc', kind }. */
export function routeRecord(route: string): { page: string; id: string; kind: RecordKind } | null {
  const [page, rid] = String(route ?? '')
    .replace(/^\/?(app\/)?/, '')
    .split('?')[0]
    .split('/');
  const kind = RECORD_KINDS[page];
  if (!kind || !rid || !/^[A-Za-z0-9_-]{1,64}$/.test(rid) || TABS[page]?.includes(rid)) return null;
  return { page, id: rid, kind };
}

/** Loads the record of a route with the caller's rights: entity for the context line plus the record itself (null when hidden). */
export async function resolveRecord(caller: Caller, route: string): Promise<{ entity: { type: string; id: string; label: string }; label: string; record: any } | null> {
  const rr = routeRecord(route);
  if (!rr) return null;
  try {
    const r = await caller.api('GET', rr.kind.path(rr.id));
    const rec = r?.ticket ?? r?.invoice ?? r;
    const name = String(rr.kind.name(rec) ?? '').slice(0, 120);
    return { entity: { type: rr.kind.type, id: rr.id, label: name }, label: `${rr.kind.label}: ${name.slice(0, 80)}`, record: rec };
  } catch {
    return null;
  }
}
