/**
 * Umzug zu HyperLevel – small helpers of the wizard (web/src/pages/Umzug*.tsx): an API client bound to the chosen
 * target sub-account (the rest of the app talks to the sub-account selected in the menu), upload of export
 * files, and German labels.
 */

export class UmzugApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(target: string, method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: { 'x-pghl': '1', 'x-location-id': target, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data: any = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event('pghl:logout'));
    throw new UmzugApiError(r.status, data?.error || `Fehler ${r.status}`);
  }
  return data as T;
}

/** An API client for one sub-account (every call carries its id). */
export function umzugApi(target: string) {
  return {
    get: <T = any>(p: string) => call<T>(target, 'GET', p),
    post: <T = any>(p: string, b: unknown = {}) => call<T>(target, 'POST', p, b),
    put: <T = any>(p: string, b: unknown = {}) => call<T>(target, 'PUT', p, b),
    patch: <T = any>(p: string, b: unknown = {}) => call<T>(target, 'PATCH', p, b),
    del: <T = any>(p: string) => call<T>(target, 'DELETE', p),
    /** The file's bytes as the body (up to the server's limit), name and source in the query. */
    upload: async (source: string, file: File, kind = ''): Promise<any> => {
      const q = new URLSearchParams({ source, name: file.name, ...(kind ? { kind } : {}) });
      const r = await fetch(`/api/umzug/files?${q}`, { method: 'POST', headers: { 'x-pghl': '1', 'x-location-id': target, 'content-type': 'application/octet-stream' }, body: file, credentials: 'same-origin' });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new UmzugApiError(r.status, data?.error || `Fehler ${r.status}`);
      return data;
    },
  };
}
export type UmzugApi = ReturnType<typeof umzugApi>;

export const JOB_STATUS: Record<string, [string, 'blue' | 'green' | 'red' | 'yellow' | 'gray' | 'purple']> = {
  running: ['läuft', 'blue'],
  done: ['fertig', 'green'],
  failed: ['abgebrochen', 'red'],
  interrupted: ['pausiert', 'yellow'],
  undoing: ['wird rückgängig gemacht', 'purple'],
  undone: ['rückgängig gemacht', 'gray'],
};

export const FIELD_TYPE_LABELS: [string, string][] = [
  ['text', 'Text'],
  ['textarea', 'Langer Text'],
  ['number', 'Zahl'],
  ['date', 'Datum'],
  ['select', 'Auswahl'],
  ['checkbox', 'Ja/Nein'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['url', 'Webadresse'],
];

export const STD_FIELDS: [string, string][] = [
  ['first_name', 'Vorname'],
  ['last_name', 'Nachname'],
  ['email', 'E-Mail'],
  ['phone', 'Telefon'],
  ['company', 'Firma'],
  ['address', 'Straße'],
  ['city', 'Ort'],
  ['postal_code', 'PLZ'],
  ['country', 'Land'],
  ['website', 'Webseite'],
  ['date_of_birth', 'Geburtstag'],
  ['source', 'Quelle'],
];

/** What a mapping target means, in words. */
export function targetLabel(t: string, custom: { key: string; label: string }[] = []): string {
  if (!t) return 'Überspringen';
  const std = STD_FIELDS.find(([k]) => k === t);
  if (std) return std[1];
  if (t === 'tag') return 'Als Tag';
  if (t.startsWith('tag:')) return `Als Tag „${t.slice(4)}…“`;
  if (t === 'note') return 'Als Notiz';
  if (t.startsWith('custom:')) return `Eigenes Feld: ${custom.find((c) => c.key === t.slice(7))?.label ?? t.slice(7)}`;
  if (t.startsWith('new:')) {
    const [, type, ...label] = t.split(':');
    return `Neues Feld: ${label.join(':')} (${FIELD_TYPE_LABELS.find(([k]) => k === type)?.[1] ?? type})`;
  }
  return t;
}

export const PART_KIND: Record<string, string> = { contacts: 'contact', segments: 'smart_list', companies: 'company', deals: 'deal', notes: 'note', tasks: 'task', templates: 'template', products: 'product', courses: 'course', students: 'enrollment', forms: 'form', automations: 'workflow' };

export const EXISTING_LABELS: Record<string, string> = { contact: 'Kontakte', smart_list: 'Smart Lists', company: 'Firmen', deal: 'Deals', pipeline: 'Pipelines', note: 'Notizen', task: 'Aufgaben', template: 'Vorlagen', product: 'Produkte', course: 'Kurse', lesson: 'Lektionen', enrollment: 'Zugänge', form: 'Formulare', workflow: 'Automationen', reference: 'Referenzlisten', ticket: 'Tickets', article: 'Hilfe-Artikel', kb_category: 'Hilfe-Kategorien', conversation: 'Gespräche', project: 'Projekte', pm_task: 'Aufgaben in Projekten', doc: 'Wiki-Seiten', object_type: 'Eigene Objekte', object_record: 'Datensätze in eigenen Objekten', pm_section: '', pm_comment: '', object_prop: '', projects: 'Projekte', project_tasks: 'Aufgaben in Projekten', docs: 'Wiki-Seiten', object_types: 'Eigene Objekte', object_records: 'Datensätze in eigenen Objekten', tickets: 'Tickets', articles: 'Hilfe-Artikel', kb_categories: 'Hilfe-Kategorien', references: 'Referenzlisten', consent_events: 'Einwilligungs-Nachweise', messages: 'Nachrichten im Postfach', wiki_spaces: 'Wiki-Bereiche', submission: 'Formular-Antworten', submissions: 'Formular-Antworten', calendar: 'Kalender', calendars: 'Kalender', appointment: 'Termine', appointments: 'Termine', activities: 'Verlaufseinträge', activity: 'Verlaufseinträge', form_submission: '' };

export const sizeLabel = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Status of a mail-domain check → badge text and tone. */
export const DOMAIN_STATUS: Record<string, [string, 'green' | 'yellow' | 'red' | 'gray']> = {
  ok: ['In Ordnung', 'green'],
  warn: ['Prüfen', 'yellow'],
  fail: ['Fehler', 'red'],
  unknown: ['Unklar', 'gray'],
  new: ['Noch nicht geprüft', 'gray'],
};

export const PART_NAMES: Record<string, string> = {
  contacts: 'Kontakte',
  segments: 'Segmente',
  companies: 'Firmen',
  deals: 'Deals',
  notes: 'Notizen',
  tasks: 'Aufgaben',
  templates: 'E-Mail-Vorlagen',
  campaigns: 'Kampagnen-Verlauf',
  forms: 'Formulare',
  automations: 'Automationen',
  products: 'Produkte',
  courses: 'Kurse',
  students: 'Teilnehmer und Zugänge',
  reference: 'Referenzlisten (Wiki)',
  tickets: 'Tickets',
  articles: 'Hilfe-Artikel',
  conversations: 'Gespräche',
  projects: 'Projekte und Aufgaben',
  comments: 'Kommentare zu Aufgaben',
  docs: 'Dokumente (Wiki)',
  objects: 'Tabellen (eigene Objekte)',
  submissions: 'Formular-Antworten',
  calendars: 'Kalender',
  appointments: 'Termine',
  documents: 'Belege (Verlauf)',
};

// --- shapes of /api/umzug ------------------------------------------------------------------------------------------------------
export interface CredDef { key: string; label: string; secret: boolean; placeholder: string; hint: string; optional: boolean }
export interface PartDef { key: string; label: string; on?: boolean; note?: string }
export interface ExportDef { key: string; label: string; accept: string[]; describe: string; part: string }
export interface SourceInfo { key: string; label: string; tagline: string; credentials: CredDef[]; howto: string[]; limits: string[]; parts: PartDef[]; exports: ExportDef[] }
export interface Conn { connected: boolean; label?: string; hint?: string; account?: string; updated_at?: string }
export interface UFile { id: string; source: string; kind: string; name: string; size: number; created_at: string; detected?: string; rows?: number; tables?: { name: string; columns: number; rows: number; header: string[] }[] }
export interface ReportRow { key: string; label: string; created: number; updated: number; skipped: number; failed: number }
export interface UndoInfo { deleted: Record<string, number>; restored: number; kept: Record<string, number>; notes: string[] }
export interface Job {
  id: string;
  source: string;
  source_label: string;
  kind: 'import' | 'dry_run';
  status: string;
  origin: 'api' | 'file';
  parts: string[];
  error: string | null;
  created_at: string;
  finished_at: string | null;
  undone_at: string | null;
  step: string;
  step_label: string;
  processed: number;
  total: number | null;
  percent: number;
  steps: { id: string; label: string; done: boolean }[];
  notes: string[];
  report: ReportRow[];
  undo: UndoInfo | null;
  warnings?: string[];
  log?: string[];
}
