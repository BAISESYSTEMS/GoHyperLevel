import { fieldKey } from './umzug-text.js';
import type { FetchFn, VendorHttp } from './umzug-http.js';

/**
 * Umzug (switch-over importers): the shared vocabulary. Every source – an API client or an uploaded
 * export file – turns what it reads into small, normalised records (`Rec`); one writer applies them to
 * HyperLevel (umzug-write.ts) and one engine runs the steps as a resumable job (umzug-engine.ts). A source
 * therefore only fetches and maps; dedupe, ids, undo, dry run and the report are the same for all.
 */

/**
 * The registry of sources: one line per vendor (key → label). The key list, the `SourceKey` type and the wizard's order
 * all derive from it; the matching `SourceDef` goes into umzug-sources.ts (SOURCES) – nothing else needs to know a vendor.
 */
export const SOURCE_LABELS = {
  mailchimp: 'Mailchimp',
  activecampaign: 'ActiveCampaign',
  kit: 'Kit (ConvertKit)',
  kajabi: 'Kajabi',
  teachable: 'Teachable',
  keap: 'Keap',
  pipedrive: 'Pipedrive',
  systeme: 'systeme.io',
  klaviyo: 'Klaviyo',
  brevo: 'Brevo',
  klicktipp: 'KlickTipp',
  manychat: 'ManyChat',
  zendesk: 'Zendesk',
  intercom: 'Intercom',
  salesforce: 'Salesforce',
  zoho: 'Zoho CRM',
  monday: 'monday.com',
  clickup: 'ClickUp',
  notion: 'Notion',
  airtable: 'Airtable',
  typeform: 'Typeform',
  calendly: 'Calendly',
  lexoffice: 'Lexware Office (lexoffice)',
  sevdesk: 'sevDesk',
} as const;
export type SourceKey = keyof typeof SOURCE_LABELS;
export const SOURCE_KEYS = Object.keys(SOURCE_LABELS) as SourceKey[];
/** The first wave of importers: they mark the consent with do-not-disturb and a tag only. Every source added later also writes the consent ledger (also for its export files). */
export const NO_LEDGER_SOURCES: ReadonlySet<string> = new Set(['mailchimp', 'activecampaign', 'kit', 'kajabi', 'teachable', 'keap', 'pipedrive']);
export const isSourceKey = (v: unknown): v is SourceKey => typeof v === 'string' && (SOURCE_KEYS as readonly string[]).includes(v);

/** What a person can tick in the wizard. A part runs one or more steps. */
export const PART_KEYS = ['contacts', 'segments', 'companies', 'deals', 'notes', 'tasks', 'templates', 'campaigns', 'forms', 'automations', 'products', 'courses', 'students', 'reference', 'tickets', 'articles', 'conversations', 'projects', 'comments', 'docs', 'objects', 'submissions', 'calendars', 'appointments', 'documents'] as const;
export type PartKey = (typeof PART_KEYS)[number];

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'checkbox' | 'email' | 'phone' | 'url';

/** How a person's e-mail consent arrived: anything but "ok" means do not disturb. */
export type Consent = 'ok' | 'unsubscribed' | 'bounced' | 'complained' | 'pending' | 'blocked' | 'unknown';

/**
 * One statement of the source about a consent, for the consent ledger (umzug-extra.ts), per channel:
 *   confirmed  the vendor holds an explicit, dated opt-in (confirmed double opt-in, recorded consent with its method) → `granted`
 *   legacy     "subscribed", but no proof of its own → `legacy` (Altbestand; the note says where it came from)
 *   revoked    unsubscribed, bounced, blocked, complained … → `revoked`
 *   none       the person never opted in (a customer, a transactional profile) → `declined`, so advertising is blocked
 * A contact record without `proof` writes nothing to the ledger; a pending double opt-in has no proof (they never said yes).
 */
export interface ConsentProof {
  basis: 'confirmed' | 'legacy' | 'revoked' | 'none';
  /** Default email. */
  channel?: 'email' | 'sms';
  /** When the vendor recorded it. */
  at?: string;
  /** The vendor's word for how it arrived ("Formular", "double opt-in", "import") – goes into the note. */
  method?: string;
  /** The page or form where it was given, when the vendor knows (shown as proof link). */
  url?: string;
  /** Why it was withdrawn ("hat sich abgemeldet", "Spam-Beschwerde"); default from the contact's consent. */
  reason?: string;
  /** Free text appended to the ledger note. */
  note?: string;
}

// --- normalised records ----------------------------------------------------------------------

export interface RContact {
  kind: 'contact';
  ext: string;
  /** Raw values by source field reference (see SourceField.ref); the mapping decides where each goes. */
  values: Record<string, unknown>;
  tags?: string[];
  consent?: Consent;
  /** The vendor's own word for the status ("unsubscribed", "cleaned") – becomes a tag. */
  native_status?: string;
  consent_at?: string;
  created_at?: string;
  /** Owner in the source (user ext id) – only noted. */
  owner?: string;
  /** Company ext id, to link when the company step ran. */
  org?: string;
  org_name?: string;
  /** Statements for the consent ledger (see ConsentProof): one per channel; sources that only know "subscribed" give a legacy one. */
  proof?: ConsentProof | ConsentProof[];
}
export interface RTagRec {
  kind: 'tag';
  name: string;
}
/** Adds tags to a contact imported earlier (list/segment members). */
export interface RMembership {
  kind: 'membership';
  contact: string;
  tags: string[];
}
export interface RSmartList {
  kind: 'smart_list';
  ext: string;
  name: string;
  /** The segment became this tag (members were tagged); the list filters on it. */
  tag?: string;
  note?: string;
}
export interface RCompany {
  kind: 'company';
  ext: string;
  name: string;
  domain?: string;
  website?: string;
  phone?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  industry?: string;
}
export interface RStage {
  ext: string;
  name: string;
  probability?: number;
}
export interface RPipeline {
  kind: 'pipeline';
  ext: string;
  name: string;
  stages: RStage[];
}
export interface RDeal {
  kind: 'deal';
  ext: string;
  name: string;
  /** Whole euros (HyperLevel stores opportunity values in euros). */
  value: number;
  pipeline: string;
  stage: string;
  contact?: string;
  org?: string;
  status: 'open' | 'won' | 'lost';
  created_at?: string;
  currency?: string;
  /** Contact data when the deal's person was not imported (name/email), so the deal can still land. */
  contact_hint?: { name?: string; email?: string };
}
export interface RNote {
  kind: 'note';
  ext: string;
  contact?: string;
  deal?: string;
  body: string;
  at?: string;
}
export interface RTask {
  kind: 'task';
  ext: string;
  contact?: string;
  deal?: string;
  title: string;
  description?: string;
  due_at?: string;
  done?: boolean;
  completed_at?: string;
  /** call, meeting, email … – becomes part of the title. */
  type?: string;
}
export interface RTemplate {
  kind: 'template';
  ext: string;
  name: string;
  subject?: string;
  html?: string;
  text?: string;
  note?: string;
}
export interface RProduct {
  kind: 'product';
  ext: string;
  name: string;
  description?: string;
  price_cents: number;
  currency?: string;
  recurring?: { interval: 'month' | 'year' | 'week'; count?: number };
  active?: boolean;
}
export interface RLesson {
  ext: string;
  title: string;
  video_url?: string;
  body?: string;
  duration_min?: number;
  published?: boolean;
}
export interface RModule {
  ext: string;
  title: string;
  lessons: RLesson[];
}
export interface RCourse {
  kind: 'course';
  ext: string;
  title: string;
  description?: string;
  cover?: string;
  modules: RModule[];
}
export interface REnrollment {
  kind: 'enrollment';
  ext: string;
  course: string;
  /** Contact ext id (when the contacts were imported) … */
  contact?: string;
  /** … or e-mail and name, to find or create the person. */
  email?: string;
  name?: string;
  enrolled_at?: string;
  completed_at?: string;
  /** Lesson ext ids the student finished. */
  lessons_done?: string[];
}
export interface RForm {
  kind: 'form';
  ext: string;
  name: string;
  fields?: { label: string; type?: string; required?: boolean; options?: string[] }[];
  note?: string;
}
export interface RWorkflow {
  kind: 'workflow';
  ext: string;
  name: string;
  trigger: { type: string; config?: Record<string, unknown> };
  steps: Record<string, unknown>[];
  warnings: string[];
}
export interface RActivity {
  kind: 'activity';
  ext: string;
  contact?: string;
  type: string;
  summary: string;
  data?: Record<string, unknown>;
  at?: string;
}
/**
 * A reference list: things that cannot be rebuilt automatically (funnels, flows, automations …) kept as a wiki page in the
 * space "Umzug", so nothing is forgotten when the old account is closed. `group` collects several records onto one page.
 */
export interface RReference {
  kind: 'reference';
  ext: string;
  /** Page title ("Funnels aus systeme.io"). */
  title: string;
  /** Markdown body. */
  body: string;
}
export interface RTicketComment {
  ext: string;
  /** Who wrote it: the customer or somebody of the team. */
  from: 'customer' | 'agent';
  /** An internal note (agents only). */
  internal?: boolean;
  author?: string;
  body: string;
  at?: string;
}
/** A helpdesk ticket with its conversation; imported without SLA timers, e-mails or workflow events. */
export interface RTicket {
  kind: 'ticket';
  ext: string;
  subject: string;
  description?: string;
  /** The vendor's status word ("open", "pending", "solved" …): mapped to a stage by meaning. */
  status?: string;
  priority?: string;
  contact?: string;
  contact_hint?: { name?: string; email?: string };
  tags?: string[];
  channel?: string;
  assignee?: string;
  created_at?: string;
  comments: RTicketComment[];
}
export interface RKbCategory {
  kind: 'kb_category';
  ext: string;
  name: string;
  description?: string;
}
/** A help-center article; saved as a DRAFT (images and links still point at the old tool – check before publishing). */
export interface RArticle {
  kind: 'article';
  ext: string;
  title: string;
  /** HTML (converted to Markdown) … */
  html?: string;
  /** … or Markdown. */
  markdown?: string;
  category?: string;
  tags?: string[];
  created_at?: string;
}
export interface RMessage {
  ext: string;
  from: 'customer' | 'agent';
  /** An internal note: it becomes a note on the contact, not a message in the thread. */
  internal?: boolean;
  author?: string;
  /** Plain text. */
  body: string;
  at?: string;
}
/** A conversation (chat, e-mail) as history in the inbox: stored messages only – nothing is sent, nothing is unread. */
export interface RConversation {
  kind: 'conversation';
  ext: string;
  contact?: string;
  contact_hint?: { name?: string; email?: string };
  subject?: string;
  channel?: 'email' | 'chat';
  messages: RMessage[];
}

// --- projects, wiki pages and custom objects (monday.com, ClickUp, Notion, Airtable) -----------------------------------------

export interface RProjectField {
  /** Short stable key inside the project (a-z, 0-9, _). */
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url';
  options?: string[];
}
/** A board / list / database as a project with its own statuses (todo / active / done), sections and custom fields. */
export interface RProject {
  kind: 'project';
  ext: string;
  name: string;
  description?: string;
  color?: string;
  statuses: { name: string; category: 'todo' | 'active' | 'done'; color?: string }[];
  /** Groups of a board, folders of a list: become sections. */
  sections?: { ext: string; name: string }[];
  fields?: RProjectField[];
}
export interface RPmComment {
  ext: string;
  author?: string;
  body: string;
  at?: string;
}
/** A task (or subtask, through `parent`) of an imported project. Parents come before their subtasks. */
export interface RPmTask {
  kind: 'pm_task';
  ext: string;
  /** Project ext. */
  project: string;
  /** Section ext (inside the project). */
  section?: string;
  parent?: string;
  title: string;
  description?: string;
  /** Status name as it exists in the project (falls back to done / not done). */
  status?: string;
  done?: boolean;
  /** 0 none … 4 urgent. */
  priority?: number;
  start_at?: string;
  due_at?: string;
  tags?: string[];
  estimate_minutes?: number;
  checklists?: { title: string; items: { text: string; done?: boolean }[] }[];
  /** People at the old tool: matched to team members by e-mail, the rest is noted in the description. */
  assignees?: { name?: string; email?: string }[];
  /** Values of the project's custom fields by field key. */
  custom?: Record<string, unknown>;
  comments?: RPmComment[];
  created_at?: string;
  completed_at?: string;
  /** Where the task lives at the old tool (noted in the description). */
  url?: string;
}
/** A document / page of the old tool as a wiki page (hierarchy through `parent`, parents first). */
export interface RDoc {
  kind: 'doc';
  ext: string;
  title: string;
  /** Markdown. */
  body: string;
  parent?: string;
  /** Wiki space name (default: the vendor's name). */
  space?: string;
  icon?: string;
}
export interface RObjectProp {
  ext: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'currency' | 'date' | 'datetime' | 'select' | 'multiselect' | 'checkbox' | 'url' | 'email' | 'phone';
  options?: string[];
  /** The display property of the object (exactly one per type; the first one if none is marked). */
  primary?: boolean;
}
/** A table / database as a custom object with typed properties. */
export interface RObjectType {
  kind: 'object_type';
  ext: string;
  singular: string;
  plural?: string;
  description?: string;
  properties: RObjectProp[];
}
export interface RObjectRecord {
  kind: 'object_record';
  ext: string;
  /** Object type ext. */
  type: string;
  /** Raw values by property ext. */
  values: Record<string, unknown>;
  created_at?: string;
}
/** A link between two records (linked records / relations); both records must have been imported. */
export interface RObjectLink {
  kind: 'object_link';
  ext: string;
  a: string;
  b: string;
}

// --- form answers, calendars and appointments (Typeform, Calendly) -----------------------------------------------------------

/** One answer sheet of a form: stored with the form's submissions (never as a new lead: no workflow, no mail, no notification). */
export interface RSubmission {
  kind: 'submission';
  ext: string;
  /** Form ext (the form step has to run in the same or an earlier job). */
  form: string;
  /** Answers by question text (the way the form's own submissions are stored). */
  answers: Record<string, string | string[]>;
  contact?: string;
  contact_hint?: { name?: string; email?: string };
  at?: string;
  /** Where it came from (referrer, browser …) – kept in the submission's meta. */
  meta?: Record<string, string>;
}
/** A bookable event type as a calendar (saved inactive and without messages: nothing goes live by itself). */
export interface RCalendar {
  kind: 'calendar';
  ext: string;
  name: string;
  description?: string;
  /** Minutes. */
  duration: number;
  color?: string;
  timezone?: string;
  /** Weekly hours: mon … sun → [["09:00","17:00"]]. */
  availability?: Record<string, [string, string][]>;
  /** Hours of single days (YYYY-MM-DD), future ones only. */
  date_overrides?: Record<string, [string, string][]>;
  location?: string;
}
/** A booked or past appointment on an imported calendar (no confirmation, no reminder, no workflow). */
export interface RAppointment {
  kind: 'appointment';
  ext: string;
  calendar: string;
  title: string;
  start_at: string;
  end_at: string;
  status: 'confirmed' | 'cancelled';
  contact?: string;
  contact_hint?: { name?: string; email?: string; phone?: string };
  notes?: string;
  created_at?: string;
}

export type Rec = RContact | RTagRec | RMembership | RSmartList | RCompany | RPipeline | RDeal | RNote | RTask | RTemplate | RProduct | RCourse | REnrollment | RForm | RWorkflow | RActivity | RReference | RTicket | RKbCategory | RArticle | RConversation | RProject | RPmTask | RDoc | RObjectType | RObjectRecord | RObjectLink | RSubmission | RCalendar | RAppointment;
export type RecKind = Rec['kind'];

export interface Batch {
  records: Rec[];
  /** Where to continue after this batch (any JSON); undefined once the step has no more pages. */
  cursor?: unknown;
  /** Total in the source, if the page says so (progress display). */
  total?: number;
}

// --- mapping -----------------------------------------------------------------------------------

export const STD_TARGETS = ['first_name', 'last_name', 'email', 'phone', 'company', 'address', 'city', 'postal_code', 'country', 'website', 'date_of_birth', 'source'] as const;
export type StdTarget = (typeof STD_TARGETS)[number];

export const STD_LABELS: Record<StdTarget, string> = {
  first_name: 'Vorname',
  last_name: 'Nachname',
  email: 'E-Mail',
  phone: 'Telefon',
  company: 'Firma',
  address: 'Straße',
  city: 'Ort',
  postal_code: 'PLZ',
  country: 'Land',
  website: 'Webseite',
  date_of_birth: 'Geburtstag',
  source: 'Quelle',
};

/**
 * A field of the source as the preview shows it. `target` is what auto-mapping suggests and what a
 * person can change:
 *   ''            skip
 *   first_name …  a standard contact field (STD_TARGETS)
 *   custom:<key>  an existing custom field
 *   new:<type>:<label>  create a custom field with this label (type from FieldType)
 *   tag | tag:<prefix>  the value becomes a tag (prefix + value)
 *   note          the value becomes a note on the contact
 */
export interface SourceField {
  ref: string;
  label: string;
  type: FieldType;
  /** Suggested standard field from the source's own naming. */
  std?: StdTarget;
  /** Fixed suggestion that beats auto-mapping ('' = skip, 'tag' …) – columns the reader uses itself (status, ids, tags). */
  preset?: string;
  options?: string[];
  /** Up to three example values for the preview. */
  sample?: string[];
  group?: 'standard' | 'custom';
}
export type Mapping = Record<string, string>;

export interface CustomFieldRow {
  key: string;
  label: string;
  type: string;
}

/** Default mapping: standard fields by the source's naming, custom fields onto a field with the same label, else a new one. */
export function autoMap(fields: SourceField[], existing: CustomFieldRow[]): Mapping {
  const byLabel = new Map(existing.map((f) => [f.label.trim().toLowerCase(), f]));
  const byKey = new Map(existing.map((f) => [f.key, f]));
  const taken = new Set<string>();
  const out: Mapping = {};
  for (const f of fields) {
    if (f.preset !== undefined) {
      out[f.ref] = f.preset;
      continue;
    }
    if (f.std && !taken.has(f.std)) {
      out[f.ref] = f.std;
      taken.add(f.std);
      continue;
    }
    const hit = byLabel.get(f.label.trim().toLowerCase()) ?? byKey.get(fieldKey(f.label));
    out[f.ref] = hit ? `custom:${hit.key}` : `new:${f.type}:${f.label.trim().slice(0, 100)}`;
  }
  return out;
}

export type Target = { kind: 'skip' } | { kind: 'std'; field: StdTarget } | { kind: 'custom'; key: string } | { kind: 'new'; type: FieldType; label: string; key: string } | { kind: 'tag'; prefix: string } | { kind: 'note' };

const TYPES: FieldType[] = ['text', 'textarea', 'number', 'date', 'select', 'checkbox', 'email', 'phone', 'url'];

export function parseTarget(t: unknown): Target {
  const s = String(t ?? '').trim();
  if (!s || s === 'skip') return { kind: 'skip' };
  if ((STD_TARGETS as readonly string[]).includes(s)) return { kind: 'std', field: s as StdTarget };
  if (s === 'note') return { kind: 'note' };
  if (s === 'tag') return { kind: 'tag', prefix: '' };
  if (s.startsWith('tag:')) return { kind: 'tag', prefix: s.slice(4).slice(0, 60) };
  if (s.startsWith('custom:')) {
    const key = s.slice(7);
    return /^[a-z0-9_]{1,60}$/.test(key) ? { kind: 'custom', key } : { kind: 'skip' };
  }
  if (s.startsWith('new:')) {
    const [, type, ...rest] = s.split(':');
    const label = rest.join(':').trim().slice(0, 100);
    if (!label) return { kind: 'skip' };
    return { kind: 'new', type: (TYPES as string[]).includes(type) ? (type as FieldType) : 'text', label, key: fieldKey(label) };
  }
  return { kind: 'skip' };
}

/** Checks a mapping coming from the browser: unknown refs and targets are dropped, never trusted. */
export function cleanMapping(input: unknown, fields: SourceField[]): Mapping {
  const refs = new Set(fields.map((f) => f.ref));
  const out: Mapping = {};
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const [ref, t] of Object.entries(input as Record<string, unknown>)) {
      if (!refs.has(ref)) continue;
      const parsed = parseTarget(t);
      out[ref] = parsed.kind === 'skip' ? '' : parsed.kind === 'new' ? `new:${parsed.type}:${parsed.label}` : String(t);
    }
  }
  return out;
}

/** Turns a raw value into what a custom field of this type stores. */
export function fieldValue(v: unknown, type: string): string | number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).join(', ') || undefined;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 500);
  if (typeof v === 'boolean') return v ? 'ja' : 'nein';
  const s = String(v).trim();
  if (!s) return undefined;
  if (type === 'number') {
    const n = Number(s.replace(/\./g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : Number.isFinite(Number(s)) ? Number(s) : s;
  }
  return s.slice(0, 2000);
}

// --- sources -------------------------------------------------------------------------------------

export interface CredField {
  key: string;
  label: string;
  /** password fields are sealed and never sent back. */
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  /** A real password: kept exactly as typed (no whitespace stripping) and never part of the "Schlüssel …1234" hint. */
  password?: boolean;
}
export interface PartDef {
  key: PartKey;
  label: string;
  /** Ticked by default. */
  on?: boolean;
  /** What happens to it, shown under the checkbox. */
  note?: string;
}
export interface CountRow {
  part: PartKey;
  key: string;
  label: string;
  /** Number in the source (null = unknown / not readable). */
  total: number | null;
  error?: string;
}

export interface Account {
  /** Stable key of the vendor account – ids are only unique inside it. */
  account: string;
  label: string;
  meta?: Record<string, string>;
  /**
   * Credentials to keep INSTEAD of what was typed, sealed like it: a one-time code that connect() exchanged for a long-lived refresh
   * token (Zoho). Never shown again.
   */
  secrets?: Record<string, string>;
}

/** Everything a step needs while it runs. */
export interface StepCtx {
  http: VendorHttp;
  creds: Record<string, string>;
  meta: Record<string, string>;
  /** Resume point of this step (what the last batch returned as `cursor`). */
  cursor: any;
  cancelled(): boolean;
  warn(message: string): void;
  /** Dry runs read at most this many records per step. */
  limit: number;
  options: JobOptions;
  /** The parts ticked for this job (a step may load extra data when another part needs it). */
  parts: PartKey[];
}
export interface StepDef {
  id: string;
  label: string;
  part: PartKey;
  run(ctx: StepCtx): AsyncGenerator<Batch, void, void>;
}

export interface SourceDeps {
  fetch?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  pauseMs?: number;
}

export interface SourceDef {
  key: SourceKey;
  label: string;
  tagline: string;
  /** Where the credentials come from – shown in the wizard (German, short). */
  credentials: CredField[];
  howto: string[];
  /** What does not move – shown next to the choices and in docs/umzug.md. */
  limits: string[];
  parts: PartDef[];
  /** CSV/JSON export files this source accepts (see umzug-files.ts for how they are read). */
  exports: ExportDef[];
  http(creds: Record<string, string>, meta: Record<string, string>, deps: SourceDeps): VendorHttp;
  /** Validates the credentials with one harmless call. */
  connect(creds: Record<string, string>, deps: SourceDeps): Promise<Account>;
  /** Counts per part and the fields available for mapping. */
  describe(http: VendorHttp, parts: PartKey[], ctx: { creds: Record<string, string>; meta: Record<string, string> }): Promise<{ counts: CountRow[]; fields: SourceField[]; warnings: string[] }>;
  steps(parts: PartKey[]): StepDef[];
}

export interface ExportDef {
  key: string;
  label: string;
  accept: string[];
  /** One sentence: what the file is and where to get it. */
  describe: string;
  part: PartKey;
}

export interface JobOptions {
  /** Existing contacts with the same e-mail/phone: fill empty fields only (default) or overwrite. */
  merge: 'fill' | 'overwrite';
  /** Tag every imported contact with this. */
  tag?: string;
  /** Keep uploaded export files after the import (default: delete – they hold personal data). */
  keep_files?: boolean;
}
export const DEFAULT_OPTIONS: JobOptions = { merge: 'fill' };

export function cleanOptions(v: any): JobOptions {
  const o = v && typeof v === 'object' ? v : {};
  return {
    merge: o.merge === 'overwrite' ? 'overwrite' : 'fill',
    tag: typeof o.tag === 'string' && o.tag.trim() ? o.tag.trim().slice(0, 80) : undefined,
    keep_files: !!o.keep_files,
  };
}

/** Standard header → field guesses shared by the CSV readers and the API sources' naming. */
export const STD_ALIASES: Record<StdTarget, string[]> = {
  first_name: ['firstname', 'first', 'fname', 'givenname', 'vorname', 'given_name', 'first_name', 'firstnames'],
  last_name: ['lastname', 'last', 'lname', 'familyname', 'surname', 'nachname', 'family_name', 'last_name'],
  email: ['email', 'emailaddress', 'e-mail', 'mail', 'emailaddress1', 'emailwork', 'personemailwork', 'primaryemail', 'emailadresse', 'email1'],
  phone: ['phone', 'phonenumber', 'telephone', 'telefon', 'mobile', 'mobil', 'handy', 'phone1', 'phonework', 'personphonework', 'cell', 'mobilephone'],
  company: ['company', 'companyname', 'organization', 'organisation', 'org', 'firma', 'account', 'orgname', 'organizationname', 'personorganization', 'unternehmen'],
  address: ['address', 'address1', 'street', 'strasse', 'straße', 'addr1', 'addressline1', 'streetaddress', 'adresse'],
  city: ['city', 'town', 'stadt', 'ort', 'locality'],
  postal_code: ['zip', 'zipcode', 'postalcode', 'postcode', 'plz', 'postleitzahl'],
  country: ['country', 'land', 'countrycode'],
  website: ['website', 'web', 'url', 'webseite', 'homepage', 'site'],
  date_of_birth: ['birthday', 'birthdate', 'dateofbirth', 'dob', 'geburtstag', 'geburtsdatum', 'birth'],
  source: ['source', 'leadsource', 'quelle', 'origin'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, '');
const ALIAS_INDEX = new Map<string, StdTarget>();
for (const [target, names] of Object.entries(STD_ALIASES) as [StdTarget, string[]][]) for (const n of names) ALIAS_INDEX.set(norm(n), target);

/** Standard field a column/field name most likely means (undefined = custom). */
export function guessStd(name: string): StdTarget | undefined {
  return ALIAS_INDEX.get(norm(name));
}
