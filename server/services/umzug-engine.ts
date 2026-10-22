import type { App } from '../core/app.js';
import { parseJson } from '../core/db.js';
import { now } from '../core/util.js';
import { DEFAULT_OPTIONS, SOURCE_LABELS, autoMap, cleanMapping, type Batch, type CountRow, type JobOptions, type Mapping, type PartKey, type Rec, type SourceDef, type SourceDeps, type SourceField, type SourceKey, type StepCtx, type StepDef } from './umzug-core.js';
import { UmzugError } from './umzug-http.js';
import { undoExtra } from './umzug-extra.js';
import { undoSubmissions } from './umzug-booking.js';
import { Writer, type Stats } from './umzug-write.js';

/**
 * The job runner of the switch-over importers: runs a source's steps page by page, applies each page in one
 * transaction (a record that fails is rolled back alone and reported, never the whole page), saves the
 * resume point after every page, and can run as a dry run. Undo and the final report live here as well.
 */

export class Cancelled extends Error {}

export interface Progress {
  step: string;
  done_steps: string[];
  cursor: unknown;
  processed: number;
  total: number | null;
  stats: Stats;
  notes: string[];
  steps: { id: string; label: string }[];
}
export const emptyProgress = (): Progress => ({ step: '', done_steps: [], cursor: null, processed: 0, total: null, stats: {}, notes: [], steps: [] });

export const STAT_LABELS: Record<string, string> = {
  custom_fields: 'Eigene Felder',
  tags: 'Tags',
  contacts: 'Kontakte',
  memberships: 'Listen-/Segment-Zuordnungen',
  smart_lists: 'Smart Lists',
  companies: 'Firmen',
  pipelines: 'Pipelines',
  deals: 'Deals',
  deals_without_contact: 'Deals ohne Kontakt',
  notes: 'Notizen',
  tasks: 'Aufgaben',
  activities: 'Verlauf',
  templates: 'E-Mail-Vorlagen',
  products: 'Produkte',
  courses: 'Kurse',
  lessons: 'Lektionen',
  enrollments: 'Zugänge',
  forms: 'Formulare (Entwürfe)',
  workflows: 'Automationen (Entwürfe)',
  consent_events: 'Einwilligungs-Nachweise',
  references: 'Referenzlisten (Wiki)',
  tickets: 'Tickets',
  ticket_comments: 'Ticket-Verlauf',
  kb_categories: 'Hilfe-Kategorien',
  articles: 'Hilfe-Artikel (Entwürfe)',
  conversations: 'Gespräche (Postfach)',
  messages: 'Nachrichten im Postfach',
  conversation_notes: 'Notizen aus Gesprächen',
  projects: 'Projekte',
  project_fields: 'Eigene Projektfelder',
  project_tasks: 'Aufgaben in Projekten',
  project_comments: 'Kommentare zu Aufgaben',
  docs: 'Wiki-Seiten',
  object_types: 'Eigene Objekte',
  object_records: 'Datensätze in eigenen Objekten',
  object_links: 'Verknüpfungen zwischen Datensätzen',
  submissions: 'Formular-Antworten',
  calendars: 'Kalender (inaktiv)',
  appointments: 'Termine',
};

/** Where a record that fails is counted (the others use the kind plus "s"). */
const FAIL_KEY: Record<string, string> = { contact: 'contacts', smart_list: 'smart_lists', activity: 'activities', kb_category: 'kb_categories', pm_task: 'project_tasks', object_record: 'object_records', object_link: 'object_links', object_type: 'object_types', doc: 'docs', project: 'projects', submission: 'submissions', calendar: 'calendars', appointment: 'appointments' };

export interface JobRow {
  id: string;
  location_id: string;
  source: SourceKey;
  kind: 'dry_run' | 'import';
  status: string;
  origin: 'api' | 'file';
  connection_id: string | null;
  file_ids: string[];
  parts: PartKey[];
  options: JobOptions;
  mapping: Mapping;
  progress: Progress;
  result: any;
  log: string[];
  warnings: string[];
  error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  undone_at: string | null;
}

export const jobRow = (app: App, jobId: string, loc?: string): JobRow | undefined => {
  const r = app.db.get<any>(`SELECT * FROM umzug_jobs WHERE id = ?${loc ? ' AND location_id = ?' : ''}`, jobId, ...(loc ? [loc] : []));
  return r ? (parseJson({ ...r }, ['file_ids', 'parts', 'options', 'mapping', 'progress', 'result', 'log', 'warnings']) as JobRow) : undefined;
};

/** What a step runs against: the vendor account (API) or the uploaded files. */
export interface JobInput {
  def: SourceDef | null;
  ns: string;
  creds: Record<string, string>;
  meta: Record<string, string>;
  deps: SourceDeps;
  /** File mode: steps built from the uploaded files (umzug-files.ts). */
  fileSteps?: (parts: PartKey[]) => StepDef[];
}

const STEP_LIMIT_DRY = 2000;

/** Runs (or continues) a job; resolves when finished, throws Cancelled when paused. */
export async function runJob(app: App, job: JobRow, input: JobInput, hooks: { cancelled(): boolean; log(line: string): void; save(p: Progress, warnings: string[]): void }): Promise<Progress> {
  const dry = job.kind === 'dry_run';
  const p: Progress = { ...emptyProgress(), ...job.progress };
  const warnings = [...(job.warnings ?? [])];
  const warn = (m: string) => {
    if (warnings.length < 300 && !warnings.includes(m)) warnings.push(m);
  };
  const writer = new Writer({ app, locationId: job.location_id, jobId: job.id, ns: input.ns, source: job.source, mapping: job.mapping ?? {}, options: { ...DEFAULT_OPTIONS, ...(job.options ?? {}) }, dry, stats: p.stats, warn });
  const steps = input.fileSteps ? input.fileSteps(job.parts) : (input.def?.steps(job.parts) ?? []);
  p.steps = steps.map((s) => ({ id: s.id, label: s.label }));
  const http = input.def ? input.def.http(input.creds, input.meta, input.deps) : (null as any);

  // The custom fields of the mapping exist before the first contact arrives.
  if (job.parts.includes('contacts') && !p.done_steps.includes('fields')) {
    p.step = 'fields';
    writer.ensureFields();
    p.done_steps.push('fields');
    hooks.save(p, warnings);
  }

  for (const step of steps) {
    if (p.done_steps.includes(step.id)) continue;
    if (p.step !== step.id) {
      p.step = step.id;
      p.cursor = null;
      p.processed = 0;
      p.total = null;
    }
    hooks.save(p, warnings);
    const ctx: StepCtx = {
      http,
      creds: input.creds,
      meta: input.meta,
      cursor: p.cursor ?? undefined,
      cancelled: hooks.cancelled,
      warn,
      limit: dry ? STEP_LIMIT_DRY : Infinity,
      options: { ...DEFAULT_OPTIONS, ...(job.options ?? {}) },
      parts: job.parts,
    };
    try {
      let read = 0;
      for await (const batch of step.run(ctx)) {
        if (hooks.cancelled()) throw new Cancelled('Pausiert');
        applyBatch(app, writer, batch, p, warn, step.id);
        read += batch.records.length;
        p.processed += batch.records.length;
        if (batch.total !== undefined) p.total = batch.total;
        p.cursor = batch.cursor ?? null;
        hooks.save(p, warnings);
        if (dry && read >= ctx.limit) {
          warn(`Probelauf: „${step.label}“ wurde nach ${read} Datensätzen angehalten – der echte Import liest alles.`);
          break;
        }
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof UmzugError && e.skippable) {
        p.notes.push(`${step.label}: übersprungen – ${e.message}`);
        hooks.log(`${step.label}: übersprungen – ${e.message}`);
      } else throw e;
    }
    p.done_steps.push(step.id);
    p.cursor = null;
    hooks.save(p, warnings);
    hooks.log(`${step.label}: fertig`);
  }
  p.step = 'fertig';
  hooks.save(p, warnings);
  return p;
}

/** One page: every record in a savepoint of one transaction. */
function applyBatch(app: App, writer: Writer, batch: Batch, p: Progress, warn: (m: string) => void, stepId: string) {
  const db = app.db;
  db.tx(() => {
    for (const rec of batch.records as Rec[]) {
      db.raw.exec('SAVEPOINT umzug_rec');
      try {
        writer.apply(rec);
        if (rec.kind === 'contact' && rec.org) writer.linkCompany(rec.ext, rec.org);
        db.raw.exec('RELEASE umzug_rec');
      } catch (e) {
        db.raw.exec('ROLLBACK TO umzug_rec');
        db.raw.exec('RELEASE umzug_rec');
        const key = FAIL_KEY[rec.kind] ?? `${rec.kind}s`;
        (p.stats[key] ??= { created: 0, updated: 0, skipped: 0, failed: 0 }).failed++;
        warn(`${stepId}: ${rec.kind} ${'ext' in rec ? String(rec.ext).slice(0, 40) : ''} nicht übernommen – ${(e as Error).message}`.slice(0, 300));
      }
    }
  });
}

// --- preview ------------------------------------------------------------------------------------------

export interface PreviewResult {
  source: SourceKey;
  label: string;
  origin: 'api' | 'file';
  counts: CountRow[];
  fields: SourceField[];
  mapping: Mapping;
  custom_fields: { key: string; label: string; type: string }[];
  existing: Record<string, number>;
  warnings: string[];
}

export function customFields(app: App, loc: string) {
  return app.db.all<{ key: string; label: string; type: string }>('SELECT key, label, type FROM custom_fields WHERE location_id = ? ORDER BY position, label', loc);
}

export function existingCounts(app: App, loc: string, ns: string): Record<string, number> {
  const rows = app.db.all<{ kind: string; n: number }>('SELECT kind, COUNT(*) n FROM umzug_ids WHERE location_id = ? AND ns = ? GROUP BY kind', loc, ns);
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}

export function buildPreview(app: App, loc: string, source: SourceKey, origin: 'api' | 'file', described: { counts: CountRow[]; fields: SourceField[]; warnings: string[] }, ns: string, savedMapping?: Mapping): PreviewResult {
  const cf = customFields(app, loc);
  const auto = autoMap(described.fields, cf);
  const mapping = savedMapping ? { ...auto, ...cleanMapping(savedMapping, described.fields) } : auto;
  return { source, label: SOURCE_LABELS[source], origin, counts: described.counts, fields: described.fields, mapping, custom_fields: cf, existing: existingCounts(app, loc, ns), warnings: described.warnings };
}

// --- result and report ------------------------------------------------------------------------------------

export interface ReportLine {
  key: string;
  label: string;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function reportLines(stats: Stats): ReportLine[] {
  return Object.entries(stats)
    .filter(([, s]) => s.created + s.updated + s.skipped + s.failed > 0)
    .map(([key, s]) => ({ key, label: STAT_LABELS[key] ?? key, ...s }))
    .sort((a, b) => Object.keys(STAT_LABELS).indexOf(a.key) - Object.keys(STAT_LABELS).indexOf(b.key));
}

// --- undo -------------------------------------------------------------------------------------------------------

export interface UndoResult {
  deleted: Record<string, number>;
  restored: number;
  kept: Record<string, number>;
  notes: string[];
}

const chunks = <T>(list: T[], n = 400): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, (i + 1) * n));

/** Deletes what the job created (and puts merged contacts back as they were). Rows other people changed since stay. */
export async function undoJob(app: App, job: JobRow, progress?: (done: number, total: number) => void): Promise<UndoResult> {
  const db = app.db;
  const loc = job.location_id;
  const res: UndoResult = { deleted: {}, restored: 0, kept: {}, notes: [] };
  const del = (k: string, n = 1) => (res.deleted[k] = (res.deleted[k] ?? 0) + n);
  const keep = (k: string, n = 1) => (res.kept[k] = (res.kept[k] ?? 0) + n);
  const items = db.all<{ kind: string; local_id: string; ext_id: string; created: number; before: string | null }>('SELECT kind, local_id, ext_id, created, before FROM umzug_items WHERE job_id = ?', job.id);
  const of = (kind: string, created = 1) => items.filter((i) => i.kind === kind && i.created === created);
  const gone: string[] = [];
  let done = 0;
  const total = items.length;
  const tick = async () => {
    done++;
    if (done % 200 === 0) {
      progress?.(done, total);
      await new Promise<void>((r) => setImmediate(r));
    }
  };
  const simple = async (kind: string, table: string, label = kind) => {
    for (const batch of chunks(of(kind))) {
      db.tx(() => {
        for (const it of batch) {
          if (db.run(`DELETE FROM ${table} WHERE id = ? AND location_id = ?`, it.local_id, loc).changes) {
            del(label);
            gone.push(it.local_id);
          }
        }
      });
      for (const _ of batch) await tick();
    }
  };

  await simple('note', 'notes');
  await simple('task', 'tasks');
  await simple('opportunity', 'opportunities');
  // Enrollments (and their progress) first, so a course nobody uses any more can go.
  for (const batch of chunks(of('enrollment'))) {
    db.tx(() => {
      for (const it of batch) if (db.run('DELETE FROM course_enrollments WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('enrollment'), gone.push(it.local_id));
    });
    for (const _ of batch) await tick();
  }
  const courseIds = new Set(of('course').map((c) => c.local_id));
  for (const it of of('lesson')) {
    if (!courseIds.has(db.get<{ course_id: string }>('SELECT course_id FROM course_lessons WHERE id = ?', it.local_id)?.course_id ?? '')) if (db.run('DELETE FROM course_lessons WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('lesson'), gone.push(it.local_id));
  }
  for (const it of of('module')) {
    if (!courseIds.has(db.get<{ course_id: string }>('SELECT course_id FROM course_modules WHERE id = ?', it.local_id)?.course_id ?? '')) if (db.run('DELETE FROM course_modules WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('module'), gone.push(it.local_id));
  }
  for (const it of of('course')) {
    if (db.get('SELECT 1 FROM course_enrollments WHERE course_id = ?', it.local_id)) {
      keep('course');
      res.notes.push('Ein Kurs bleibt, weil sich seitdem Personen eingeschrieben haben.');
      continue;
    }
    if (db.run('DELETE FROM courses WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('course'), gone.push(it.local_id));
  }
  for (const it of of('pipeline')) {
    if (db.get('SELECT 1 FROM opportunities WHERE pipeline_id = ?', it.local_id)) {
      keep('pipeline');
      res.notes.push('Eine Pipeline bleibt, weil sie noch Deals enthält, die nicht aus dem Umzug stammen.');
      continue;
    }
    if (db.run('DELETE FROM pipelines WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('pipeline'), gone.push(it.local_id));
  }
  await simple('template', 'templates');
  await simple('product', 'products');
  undoSubmissions(app, loc, items, { del });
  await simple('form', 'forms');
  await simple('smart_list', 'smart_lists');
  for (const it of of('workflow')) {
    const w = db.get<{ status: string }>('SELECT status FROM workflows WHERE id = ? AND location_id = ?', it.local_id, loc);
    if (!w) continue;
    if (w.status !== 'draft') {
      keep('workflow');
      res.notes.push('Eine Automation bleibt, weil sie inzwischen aktiviert wurde.');
      continue;
    }
    db.run('DELETE FROM workflows WHERE id = ? AND location_id = ?', it.local_id, loc);
    del('workflow');
    gone.push(it.local_id);
  }
  await simple('company', 'companies');
  undoExtra(app, loc, items, { del, keep, gone, notes: res.notes });

  // Contacts: created ones go (unless something happened with them since), merged ones are put back.
  const touched = (cid: string) => {
    for (const sql of ['SELECT 1 FROM messages WHERE contact_id = ? LIMIT 1', 'SELECT 1 FROM invoices WHERE contact_id = ? LIMIT 1', 'SELECT 1 FROM appointments WHERE contact_id = ? LIMIT 1', 'SELECT 1 FROM form_submissions WHERE contact_id = ? LIMIT 1']) {
      try {
        if (db.get(sql, cid)) return true;
      } catch {
        /* module not installed */
      }
    }
    return false;
  };
  for (const batch of chunks(of('contact'), 200)) {
    db.tx(() => {
      for (const it of batch) {
        if (touched(it.local_id)) {
          keep('contacts');
          continue;
        }
        if (db.run('DELETE FROM contacts WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (del('contacts'), gone.push(it.local_id));
      }
    });
    for (const _ of batch) await tick();
  }
  if (res.kept.contacts) res.notes.push(`${res.kept.contacts} Kontakte bleiben, weil es seitdem Nachrichten, Rechnungen, Termine oder Formular-Antworten gibt.`);
  for (const it of of('contact', 0)) {
    if (!it.before) continue;
    const b = JSON.parse(it.before);
    if (!db.get('SELECT 1 FROM contacts WHERE id = ? AND location_id = ?', it.local_id, loc)) continue;
    db.update('contacts', it.local_id, { ...b, updated_at: now() }, loc);
    res.restored++;
    await tick();
  }

  // Tags and custom fields the job created, if nothing uses them any more.
  for (const it of of('tag')) {
    const used = db.get('SELECT 1 FROM contacts c, json_each(c.tags) j WHERE c.location_id = ? AND j.value = ? LIMIT 1', loc, it.ext_id);
    if (used) {
      keep('tags');
      continue;
    }
    if (db.run('DELETE FROM tags WHERE id = ? AND location_id = ?', it.local_id, loc).changes) del('tags');
  }
  for (const it of of('custom_field')) {
    if (db.run('DELETE FROM custom_fields WHERE id = ? AND location_id = ?', it.local_id, loc).changes) {
      del('custom_fields');
      if (/^[a-z0-9_]+$/.test(it.ext_id)) db.run(`UPDATE contacts SET custom = json_remove(custom, '$.${it.ext_id}') WHERE location_id = ? AND json_type(custom, '$.${it.ext_id}') IS NOT NULL`, loc);
    }
  }
  // The id map forgets deleted rows, so a new import creates them again.
  for (const batch of chunks(gone)) db.run(`DELETE FROM umzug_ids WHERE location_id = ? AND local_id IN (${batch.map(() => '?').join(',')})`, loc, ...batch);
  progress?.(total, total);
  return res;
}
