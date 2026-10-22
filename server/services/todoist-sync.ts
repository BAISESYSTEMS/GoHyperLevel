import { randomUUID } from 'node:crypto';
import type { App } from '../core/app.js';
import type { Row } from '../core/db.js';
import { bad } from '../core/http.js';
import { id, now, sha256 } from '../core/util.js';
import { openSecret } from '../modules/mail-sync.js';
import {
  command,
  commandError,
  fromTodoistDue,
  isGone,
  isLimit,
  normalizeDue,
  todoistClient,
  toTodoistDue,
  type Command,
  type CommandStatus,
  type TodoistClient,
  type TodoistItem,
  type TodoistProject,
  type TodoistSection,
} from './todoist.js';

/**
 * Two-way sync between HyperLevel tasks and Todoist (agency level, one Todoist account).
 *
 * - Layout `sections` (default, fits the free plan): ONE Todoist project (named `parent_name` or
 *   an existing one) with one section per sub-account. Layout `projects`: one project per
 *   sub-account under a parent project. Either way a sub-account is auto / existing / off.
 * - `todoist_links` pairs a task with a Todoist item and keeps the last synced hash of both sides,
 *   so each run knows which side changed. Both changed → the later change wins (local time =
 *   when the change was noticed, remote = `updated_at`) and the conflict is logged.
 * - Pull: incremental Sync API reads (`sync_token`), a full read (`*`) once a day.
 * - Push: deletions, updates (incl. close/reopen) and new tasks as batched Sync commands
 *   (uuid + temp_id, so a retried request never creates duplicates).
 * - Deleted in Todoist → the task here is only marked done (never deleted) and unlinked. A
 *   deleted project/section only unlinks its tasks.
 * - A plan limit (free plan: 5 projects, 20 sections per project) stops creating things, with
 *   a German message in the status, until a manual run, a settings change or 24 hours later.
 */

export type Direction = 'both' | 'push';
export type Mode = 'auto' | 'existing' | 'off';
export type Layout = 'sections' | 'projects';

export interface TodoistConfig {
  token_sealed?: string;
  token_hint?: string;
  enabled: boolean;
  direction: Direction;
  scope: 'mine' | 'all';
  owner_user_id?: string | null;
  layout: Layout;
  /** Sections layout: name of the one project; projects layout: parent of the projects ('' = top level). */
  parent_name: string;
  /** Sections layout: use this existing project instead of finding/creating one named `parent_name`. */
  home_project_id?: string | null;
  home_project_name?: string;
  /** Sections layout: tasks in the project without a section go to this sub-account (unset = ignored). */
  unsectioned_location_id?: string | null;
  /** Sub-accounts without an explicit mapping. */
  default_mode: 'auto' | 'off';
  /** Put the label "ghp" on tasks sent to Todoist. */
  label: boolean;
  webhook_secret_sealed?: string;
  account?: { id: string; name: string; email: string; tz: string; premium?: boolean } | null;
}

export interface RunCounts {
  pulled: number;
  imported: number;
  pushed: number;
  created: number;
  deleted: number;
  closed_here: number;
  conflicts: number;
  errors: number;
}

export interface TodoistState {
  sync_token?: string;
  /** Sections layout: the project holding the sections; projects layout: the parent project. */
  parent_project_id?: string;
  /** Its name when we created/found it – a new `parent_name` renames it (sections layout). */
  parent_project_name?: string;
  last_run?: string;
  last_sync?: string;
  last_full?: string;
  last_push?: string;
  last_error?: string;
  counts?: RunCounts;
  /** A plan limit stopped creating projects/sections/tasks (shown in the status). */
  limit_error?: string;
  limit_at?: string;
}

export const DEFAULT_CONFIG: TodoistConfig = { enabled: false, direction: 'both', scope: 'all', layout: 'sections', parent_name: 'HyperLevel', default_mode: 'auto', label: true };
export const LABEL = 'ghp';
const FOOTER = '↗ HyperLevel:';
/** Also strips the footer of older versions (written under the former product names GoHigh and GoHighPaul). */
const FOOTER_RE = /\s*↗ (?:HyperLevel|GoHigh(?:Paul)?): \S+\s*$/u;
/** Never delete more than this many Todoist tasks in one run when it is also more than half of all links. */
const MASS_DELETE = 25;
const LIMIT_RETRY_MS = 24 * 3600_000;

const read = (app: App, key: string) => {
  const row = app.db.get('SELECT value FROM agency_settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : null;
};
const write = (app: App, key: string, value: unknown) =>
  app.db.run('INSERT INTO agency_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

export function getConfig(app: App): TodoistConfig {
  const stored = read(app, 'todoist');
  const cfg: TodoistConfig = { ...DEFAULT_CONFIG, ...(stored ?? {}) };
  // set up before layouts existed: stay with one project per sub-account only if that already syncs
  if (stored && !stored.layout) cfg.layout = app.db.get(`SELECT 1 AS x FROM todoist_links WHERE status = 'active' LIMIT 1`) ? 'projects' : 'sections';
  return cfg;
}
export const saveConfig = (app: App, cfg: TodoistConfig) => write(app, 'todoist', cfg);
export const getState = (app: App): TodoistState => read(app, 'todoist_state') ?? {};
export const saveState = (app: App, st: TodoistState) => write(app, 'todoist_state', st);
export const limitBlocked = (st: TodoistState) => !!st.limit_error && Date.now() - (Date.parse(st.limit_at ?? '') || 0) < LIMIT_RETRY_MS;
export const clearLimit = (app: App) => {
  const st = getState(app);
  if (st.limit_error) saveState(app, { ...st, limit_error: undefined, limit_at: undefined });
};

export function log(app: App, level: 'info' | 'warn' | 'error' | 'conflict', message: string, ref: { task_id?: string | null; todoist_id?: string | null } = {}) {
  app.db.run('INSERT INTO todoist_log (at, level, message, task_id, todoist_id) VALUES (?, ?, ?, ?, ?)', now(), level, message.slice(0, 600), ref.task_id ?? null, ref.todoist_id ?? null);
  app.db.run('DELETE FROM todoist_log WHERE id <= (SELECT MAX(id) - 500 FROM todoist_log)');
}

function hitLimit(state: TodoistState, what: string, s: CommandStatus | undefined, counts: RunCounts) {
  state.limit_error = `Todoist-Limit erreicht: ${what} (${commandError(s)}). Im kostenlosen Todoist-Plan gibt es höchstens 5 Projekte und 20 Abschnitte je Projekt – nimm das Layout „Ein Projekt mit Abschnitten“ oder wähle vorhandene Projekte/Abschnitte. Neuer Versuch nach „Jetzt abgleichen“, einer geänderten Einstellung oder in 24 Stunden.`;
  state.limit_at = now();
  counts.errors++;
}

// --- field mapping -------------------------------------------------------------------------

export interface Fields {
  title: string;
  description: string;
  due: string | null;
}
export const stripFooter = (s: unknown) => String(s ?? '').replace(FOOTER_RE, '').trim();
export const withFooter = (desc: string, url: string) => `${desc.trim()}${desc.trim() ? '\n\n' : ''}${FOOTER} ${url}`;
export const localFields = (t: Row): Fields => ({ title: String(t.title ?? '').trim(), description: String(t.description ?? '').trim(), due: normalizeDue(t.due_at) });
export const remoteFields = (item: TodoistItem, tz: string): Fields => ({
  title: String(item.content ?? '').trim().slice(0, 300),
  description: stripFooter(item.description).slice(0, 5000),
  due: normalizeDue(fromTodoistDue(item.due, tz)),
});
export const hashFields = (f: Fields) => sha256(JSON.stringify([f.title, f.description, f.due]));
const same = (a: Fields, b: Fields) => a.title === b.title && a.description === b.description && a.due === b.due;

// --- where each sub-account's tasks go -----------------------------------------------------

export interface Target {
  location_id: string;
  name: string;
  timezone: string;
  /** auto / existing / off for the current layout. */
  mode: Mode;
  project_id: string | null;
  project_name: string;
  section_id: string | null;
  section_name: string;
  /** New tasks can be sent: mapped, and the project (and section) exist. */
  ready: boolean;
}

export const homeId = (cfg: TodoistConfig, st: TodoistState) => cfg.home_project_id || st.parent_project_id || null;
export const homeName = (cfg: TodoistConfig) => cfg.home_project_name || cfg.parent_name || 'HyperLevel';

export function targets(app: App, cfg = getConfig(app), state = getState(app)): Target[] {
  const rows = new Map(app.db.all('SELECT * FROM todoist_projects').map((r) => [r.location_id, r]));
  const home = homeId(cfg, state);
  return app.db.all('SELECT id, name, timezone FROM locations ORDER BY name').map((l) => {
    const r = rows.get(l.id);
    const base = { location_id: l.id, name: l.name, timezone: l.timezone || 'Europe/Berlin' };
    if (cfg.layout === 'sections') {
      const mode = (r?.section_mode ?? cfg.default_mode) as Mode;
      return { ...base, mode, project_id: home, project_name: homeName(cfg), section_id: r?.section_id ?? null, section_name: r?.section_name ?? '', ready: mode !== 'off' && !!home && !!r?.section_id };
    }
    const mode = (r?.mode ?? cfg.default_mode) as Mode;
    return { ...base, mode, project_id: r?.project_id ?? null, project_name: r?.project_name ?? '', section_id: null, section_name: '', ready: mode !== 'off' && !!r?.project_id };
  });
}

type MappingPatch = Partial<{ mode: Mode; project_id: string | null; project_name: string; section_mode: Mode | null; section_id: string | null; section_name: string }>;
/** Updates the given columns of a sub-account's mapping (projects layout: mode/project_*, sections layout: section_*). */
export function setMapping(app: App, locationId: string, patch: MappingPatch) {
  app.db.run(`INSERT OR IGNORE INTO todoist_projects (location_id, mode, project_name, section_name, updated_at) VALUES (?, ?, '', '', ?)`, locationId, getConfig(app).default_mode, now());
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  app.db.run(
    `UPDATE todoist_projects SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE location_id = ?`,
    ...entries.map(([k, v]) => (v === null && k.endsWith('_name') ? '' : (v as string | null))), now(), locationId,
  );
}

/** Forget the links of a project/section that is gone in Todoist; the tasks here stay as they are. */
const dropLinks = (app: App, where: string, ...params: (string | null)[]) => app.db.run(`DELETE FROM todoist_links WHERE status IN ('active', 'pending') AND ${where}`, ...params);

function projectGone(app: App, t: Target, counts: RunCounts) {
  setMapping(app, t.location_id, { mode: 'off', project_id: null });
  dropLinks(app, 'location_id = ? AND (project_id = ? OR todoist_id IS NULL)', t.location_id, t.project_id);
  log(app, 'warn', `Todoist-Projekt „${t.project_name || t.project_id}“ gibt es nicht mehr – „${t.name}“ wird nicht mehr abgeglichen, die Aufgaben hier bleiben unverändert (unter Agentur → Integrationen neu zuordnen).`);
  counts.errors++;
}

function sectionGone(app: App, t: Target, counts: RunCounts) {
  setMapping(app, t.location_id, { section_mode: 'off', section_id: null, section_name: '' });
  dropLinks(app, 'location_id = ? AND (section_id = ? OR todoist_id IS NULL)', t.location_id, t.section_id);
  log(app, 'warn', `Todoist-Abschnitt „${t.section_name || t.section_id}“ gibt es nicht mehr – „${t.name}“ wird nicht mehr abgeglichen, die Aufgaben hier bleiben unverändert (unter Agentur → Integrationen neu zuordnen).`);
  counts.errors++;
}

/** Sections layout: the one project is gone – switch the sync off instead of guessing. */
function homeGone(app: App, cfg: TodoistConfig, state: TodoistState, counts: RunCounts) {
  const home = homeId(cfg, state);
  saveConfig(app, { ...getConfig(app), enabled: false, home_project_id: null, home_project_name: '' });
  Object.assign(cfg, { enabled: false, home_project_id: null, home_project_name: '' });
  state.parent_project_id = undefined;
  app.db.run(`UPDATE todoist_projects SET section_id = NULL, section_name = '', section_mode = CASE WHEN section_mode = 'existing' THEN NULL ELSE section_mode END`);
  dropLinks(app, '(project_id = ? OR todoist_id IS NULL)', home);
  log(app, 'error', `Das Todoist-Projekt „${homeName(cfg)}“ gibt es nicht mehr – der Abgleich ist ausgeschaltet, die Aufgaben hier bleiben unverändert. Projekt neu wählen (oder automatisch anlegen lassen) und den Abgleich wieder einschalten.`);
  counts.errors++;
}

const taskUrl = (app: App, t: Row) => (t.contact_id ? `${app.baseUrl()}/app/contacts/${t.contact_id}` : `${app.baseUrl()}/app/tasks`);

// --- run ------------------------------------------------------------------------------------

export type RunMode = 'push' | 'sync' | 'full';
const queues = new WeakMap<App, Promise<unknown>>();

/** Runs one sync at a time per app (the tick, the hook after a change and "Jetzt abgleichen" share it). */
export function runSync(app: App, mode: RunMode = 'sync'): Promise<{ ok: true; mode: RunMode; counts: RunCounts }> {
  const prev = queues.get(app) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => doRun(app, mode));
  queues.set(app, next);
  return next;
}

async function doRun(app: App, mode: RunMode) {
  const cfg = getConfig(app);
  if (!cfg.enabled || !cfg.token_sealed) throw bad('Todoist ist nicht eingerichtet oder ausgeschaltet');
  const client = todoistClient(app, openSecret(app, cfg.token_sealed));
  const state = getState(app);
  const counts: RunCounts = { pulled: 0, imported: 0, pushed: 0, created: 0, deleted: 0, closed_here: 0, conflicts: 0, errors: 0 };
  const started = now();
  const prevError = state.last_error;
  const prevLimit = state.limit_error;
  const blocked = limitBlocked(state);
  if (!blocked) Object.assign(state, { limit_error: undefined, limit_at: undefined }); // try again
  const finish = () => {
    if (state.limit_error && state.limit_error !== prevLimit) log(app, 'error', state.limit_error);
  };
  try {
    let known: TodoistProject[] | undefined;
    let knownSections: TodoistSection[] | undefined;
    if (mode === 'full') app.db.run('UPDATE todoist_links SET fail_count = 0 WHERE fail_count > 0'); // give failed tasks another try once a day
    const pulling = mode !== 'push' && cfg.direction === 'both';
    const pull = async (token: string) => {
      const res = await client.read(token);
      applyPull(app, cfg, state, res, res.full_sync ? Date.parse(res.full_sync_date_utc ?? '') || Date.now() : 0, counts);
      if (res.full_sync) (known = res.projects), (knownSections = res.sections);
      Object.assign(state, { sync_token: res.sync_token, last_sync: started, ...(res.full_sync ? { last_full: started } : {}) });
      saveState(app, state); // the pulled changes are applied – never read them twice
    };
    if (pulling) await pull(mode === 'full' ? '*' : state.sync_token || '*');
    else if (mode === 'full') state.last_full = started;
    if (cfg.enabled) {
      await ensureTargets(app, client, cfg, state, known, knownSections, counts, blocked);
      // an existing project/section was just adopted: read once more so its tasks come over now
      if (pulling && state.sync_token === undefined) await pull('*');
      await push(app, client, cfg, state, counts);
    }
    finish();
    saveState(app, { ...state, last_run: started, last_push: started, last_error: '', counts });
    return { ok: true as const, mode, counts };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== prevError) log(app, 'error', msg);
    finish();
    saveState(app, { ...state, last_run: started, last_error: msg, counts: { ...counts, errors: counts.errors + 1 } });
    throw e;
  }
}

// --- pull -----------------------------------------------------------------------------------

/** `fullAt` > 0 marks a full read and is the time of Todoist's snapshot. */
function applyPull(app: App, cfg: TodoistConfig, state: TodoistState, res: { items: TodoistItem[]; projects: TodoistProject[]; sections: TodoistSection[] }, fullAt: number, counts: RunCounts) {
  const { db } = app;
  const { items } = res;
  // projects and sections that disappeared in Todoist
  for (const p of res.projects) {
    if (!p.is_deleted && !p.is_archived) continue;
    if (cfg.layout === 'sections') {
      if (p.id === homeId(cfg, state)) homeGone(app, cfg, state, counts);
      continue;
    }
    if (p.id === state.parent_project_id) state.parent_project_id = undefined;
    for (const t of targets(app, cfg, state)) if (t.mode !== 'off' && t.project_id === p.id) projectGone(app, t, counts);
  }
  if (cfg.layout === 'sections') {
    for (const s of res.sections) {
      if (!s.is_deleted && !s.is_archived) continue;
      for (const t of targets(app, cfg, state)) if (t.mode !== 'off' && t.section_id === s.id) sectionGone(app, t, counts);
    }
  }
  if (!cfg.enabled) return; // the home project is gone – nothing to sync into

  const active = targets(app, cfg, state).filter((t) => t.mode !== 'off');
  const byLocation = new Map(active.map((t) => [t.location_id, t]));
  const byProject = new Map(active.filter((t) => t.project_id).map((t) => [t.project_id!, t]));
  const bySection = new Map(active.filter((t) => t.section_id).map((t) => [t.section_id!, t]));
  const home = homeId(cfg, state);
  /** Which sub-account a task created in Todoist belongs to (moving tasks later does not move them here). */
  const targetFor = (item: TodoistItem): Target | undefined => {
    if (cfg.layout === 'projects') return byProject.get(item.project_id);
    if (!home || item.project_id !== home) return undefined;
    if (item.section_id) return bySection.get(item.section_id);
    return cfg.unsectioned_location_id ? byLocation.get(cfg.unsectioned_location_id) : undefined;
  };
  const userTz = (t?: Target) => cfg.account?.tz || t?.timezone || 'Europe/Berlin';

  db.tx(() => {
    for (const item of items) {
      const link = db.get('SELECT * FROM todoist_links WHERE todoist_id = ?', item.id);
      if (!link) {
        const t = targetFor(item);
        if (!t || item.is_deleted || item.checked) continue;
        const f = remoteFields(item, userTz(t));
        // a create whose response got lost: adopt instead of importing a duplicate
        const pending = db.get(
          `SELECT l.* FROM todoist_links l JOIN tasks t ON t.id = l.task_id WHERE l.todoist_id IS NULL AND l.status = 'pending' AND l.project_id = ? AND TRIM(t.title) = ?`,
          item.project_id, f.title,
        );
        if (pending) {
          db.run(`UPDATE todoist_links SET todoist_id = ?, status = 'active', remote_hash = ?, local_hash = ?, synced_done = 0, remote_updated_at = ?, synced_at = ?, pending_uuid = NULL, pending_temp_id = NULL, section_id = ? WHERE task_id = ?`,
            item.id, hashFields(f), hashFields(f), item.updated_at ?? null, now(), item.section_id ?? null, pending.task_id);
          continue;
        }
        const taskId = id();
        db.insert('tasks', { id: taskId, location_id: t.location_id, contact_id: null, title: f.title || 'Aufgabe', description: f.description, due_at: f.due, assigned_to: cfg.owner_user_id ?? null, done: 0, created_at: now() });
        const lf = localFields(db.get('SELECT * FROM tasks WHERE id = ?', taskId)!);
        db.insert('todoist_links', { task_id: taskId, todoist_id: item.id, location_id: t.location_id, project_id: item.project_id, section_id: item.section_id ?? null, status: 'active', local_hash: hashFields(lf), remote_hash: hashFields(f), synced_done: 0, remote_updated_at: item.updated_at ?? null, synced_at: now(), created_at: now() });
        counts.imported++;
        continue;
      }
      if (link.status !== 'active') continue;
      const t = byLocation.get(link.location_id);
      if (!t) continue; // sub-account no longer synced
      const task = db.get('SELECT * FROM tasks WHERE id = ?', link.task_id);
      if (!task) continue; // deleted here – the push step deletes it there
      if (item.is_deleted) {
        remoteDeleted(app, cfg, link, task, counts);
        continue;
      }
      const remote = remoteFields(item, userTz(t));
      const remoteDone = !!item.checked;
      const remoteChanged = hashFields(remote) !== link.remote_hash || remoteDone !== !!link.synced_done;
      if (!remoteChanged) {
        if (item.project_id !== link.project_id || (item.section_id ?? null) !== (link.section_id ?? null)) db.run('UPDATE todoist_links SET project_id = ?, section_id = ? WHERE task_id = ?', item.project_id, item.section_id ?? null, link.task_id);
        continue;
      }
      const local = localFields(task);
      const localDone = !!task.done;
      const localChanged = hashFields(local) !== link.local_hash || localDone !== !!link.synced_done;
      if (localChanged && !(same(local, remote) && localDone === remoteDone)) {
        const localAt = Date.parse(link.local_changed_at ?? '') || Date.now();
        const remoteAt = Date.parse(item.updated_at ?? item.completed_at ?? '') || 0;
        counts.conflicts++;
        if (remoteAt > localAt) {
          log(app, 'conflict', `„${local.title}“ in beiden Systemen geändert – Todoist ist neuer und gewinnt.`, { task_id: task.id, todoist_id: item.id });
        } else {
          log(app, 'conflict', `„${local.title}“ in beiden Systemen geändert – HyperLevel ist neuer und gewinnt.`, { task_id: task.id, todoist_id: item.id });
          // remember what Todoist has now; a cleared local hash makes the push send every field
          db.run('UPDATE todoist_links SET remote_hash = ?, synced_done = ?, local_hash = NULL, remote_updated_at = ?, project_id = ?, section_id = ? WHERE task_id = ?', hashFields(remote), remoteDone ? 1 : 0, item.updated_at ?? null, item.project_id, item.section_id ?? null, link.task_id);
          continue;
        }
      }
      const patch: Row = { title: remote.title || task.title, description: remote.description, due_at: remote.due, done: remoteDone ? 1 : 0 };
      if (remoteDone && !localDone) patch.completed_at = normalizeDue(item.completed_at) ?? now();
      if (!remoteDone) patch.completed_at = null;
      db.update('tasks', task.id, patch);
      const lf = localFields({ ...task, ...patch });
      db.run(
        'UPDATE todoist_links SET local_hash = ?, remote_hash = ?, synced_done = ?, local_changed_at = NULL, remote_updated_at = ?, synced_at = ?, project_id = ?, section_id = ?, fail_count = 0, last_error = NULL WHERE task_id = ?',
        hashFields(lf), hashFields(remote), remoteDone ? 1 : 0, item.updated_at ?? null, now(), item.project_id, item.section_id ?? null, link.task_id,
      );
      counts.pulled++;
    }

    // Full read: a linked task that is no longer active there was completed or deleted while we
    // were not looking (an expired sync token, a long outage) – close it here as well. Links
    // touched shortly before the snapshot are skipped (a big account's snapshot can lag behind).
    if (fullAt) {
      const activeIds = new Set(items.filter((i) => !i.is_deleted && !i.checked).map((i) => i.id));
      const trustedBefore = new Date(fullAt - 15 * 60_000).toISOString();
      const rows = db.all(
        `SELECT l.*, t.done AS task_done, t.title FROM todoist_links l JOIN tasks t ON t.id = l.task_id
         WHERE l.status = 'active' AND l.todoist_id IS NOT NULL AND l.synced_done = 0 AND COALESCE(l.synced_at, l.created_at) < ?`,
        trustedBefore,
      );
      for (const r of rows) {
        if (activeIds.has(r.todoist_id) || !byLocation.has(r.location_id) || r.task_done) continue;
        db.update('tasks', r.task_id, { done: 1, completed_at: now() });
        db.run('UPDATE todoist_links SET synced_done = 1, local_changed_at = NULL, synced_at = ? WHERE task_id = ?', now(), r.task_id);
        log(app, 'info', `„${r.title}“ ist in Todoist nicht mehr offen – hier als erledigt markiert.`, { task_id: r.task_id, todoist_id: r.todoist_id });
        counts.closed_here++;
      }
    }
  });
}

/** Deleted in Todoist: the safe option – mark the task done here (never delete it) and unlink it. */
function remoteDeleted(app: App, cfg: TodoistConfig, link: Row, task: Row, counts: RunCounts) {
  if (cfg.direction === 'both' && !task.done) {
    app.db.update('tasks', task.id, { done: 1, completed_at: now() });
    counts.closed_here++;
  }
  app.db.run(`UPDATE todoist_links SET status = 'remote_deleted', synced_at = ? WHERE task_id = ?`, now(), link.task_id);
  log(app, 'warn', cfg.direction === 'both' ? `„${task.title}“ wurde in Todoist gelöscht – hier als erledigt markiert und abgekoppelt.` : `„${task.title}“ wurde in Todoist gelöscht – abgekoppelt.`, { task_id: task.id, todoist_id: link.todoist_id });
}

// --- projects & sections --------------------------------------------------------------------

const activeOnly = <T extends { is_deleted?: boolean; is_archived?: boolean }>(list: T[]) => list.filter((x) => !x.is_deleted && !x.is_archived);

/** Runs creation commands; a plan limit is recorded once instead of one error per command. */
async function create(app: App, client: TodoistClient, state: TodoistState, cmds: Command[], counts: RunCounts) {
  const { status, tempIds, error } = await client.commands(cmds);
  if (error) throw error;
  const limited = cmds.find((c) => isLimit(status[c.uuid]));
  if (limited) hitLimit(state, `${limited.type === 'section_add' ? 'Abschnitt' : 'Projekt'} „${String(limited.args.name)}“ konnte nicht angelegt werden`, status[limited.uuid], counts);
  else {
    for (const c of cmds) {
      if (status[c.uuid] === 'ok') continue;
      log(app, 'error', `Todoist: „${String(c.args.name)}“ (${c.type}) fehlgeschlagen: ${commandError(status[c.uuid])}`);
      counts.errors++;
    }
  }
  return { status, tempIds };
}

async function ensureTargets(app: App, client: TodoistClient, cfg: TodoistConfig, state: TodoistState, known: TodoistProject[] | undefined, knownSections: TodoistSection[] | undefined, counts: RunCounts, blocked: boolean) {
  if (cfg.layout === 'sections') return ensureSections(app, client, cfg, state, known, knownSections, counts, blocked);
  if (blocked) return;
  const need = targets(app, cfg, state).filter((t) => t.mode === 'auto' && !t.project_id);
  if (!need.length) return;
  const active = activeOnly(known ?? (await client.projects()));
  const cmds: Command[] = [];
  let parentRef: string | null = null;
  if (cfg.parent_name) {
    const parent = active.find((p) => p.id === state.parent_project_id) ?? active.find((p) => p.name === cfg.parent_name && !p.parent_id);
    if (parent) parentRef = parent.id;
    else {
      parentRef = randomUUID();
      cmds.push(command('project_add', { name: cfg.parent_name }, parentRef));
    }
  }
  const planned: { t: Target; ref: string }[] = [];
  for (const t of need) {
    const existing = active.find((p) => p.name === t.name && (p.parent_id ?? null) === parentRef);
    if (existing) {
      setMapping(app, t.location_id, { mode: 'auto', project_id: existing.id, project_name: existing.name });
      state.sync_token = undefined; // its tasks are not "changed" – the next run reads everything once
      continue;
    }
    const ref = randomUUID();
    cmds.push(command('project_add', { name: t.name.slice(0, 120), ...(parentRef ? { parent_id: parentRef } : {}) }, ref));
    planned.push({ t, ref });
  }
  if (!cmds.length) {
    state.parent_project_id = parentRef ?? undefined;
    return;
  }
  const { tempIds } = await create(app, client, state, cmds, counts);
  if (parentRef) state.parent_project_id = tempIds[parentRef] ?? (cmds[0].temp_id === parentRef ? undefined : parentRef);
  for (const { t, ref } of planned) {
    const pid = tempIds[ref];
    if (!pid) continue;
    setMapping(app, t.location_id, { mode: 'auto', project_id: pid, project_name: t.name });
    log(app, 'info', `Todoist-Projekt „${t.name}“ angelegt${cfg.parent_name ? ` (unter „${cfg.parent_name}“)` : ''}.`);
  }
}

/** Sections layout: one project (found by name, picked, or created once) with a section per sub-account. */
async function ensureSections(app: App, client: TodoistClient, cfg: TodoistConfig, state: TodoistState, known: TodoistProject[] | undefined, knownSections: TodoistSection[] | undefined, counts: RunCounts, blocked: boolean) {
  const ts = targets(app, cfg, state);
  const need = ts.filter((t) => t.mode === 'auto' && !t.section_id);
  const renames = ts.filter((t) => t.mode === 'auto' && t.section_id && t.section_name && t.section_name !== t.name);
  const cmds: Command[] = [];
  const planned: { t: Target; ref: string }[] = [];
  let homeRef = homeId(cfg, state);
  let newHome: string | null = null;
  if (need.length && !blocked) {
    if (!homeRef) {
      const found = activeOnly(known ?? (await client.projects())).find((p) => p.name === homeName(cfg) && !p.parent_id);
      if (found) {
        homeRef = state.parent_project_id = found.id;
        state.parent_project_name = found.name;
        state.sync_token = undefined; // read its tasks once
      } else {
        homeRef = newHome = randomUUID();
        cmds.push(command('project_add', { name: homeName(cfg) }, newHome));
      }
    }
    const sections = newHome ? [] : activeOnly(knownSections ?? (await client.sections(homeRef))).filter((s) => s.project_id === homeRef);
    for (const t of need) {
      const existing = sections.find((s) => s.name === t.name);
      if (existing) {
        setMapping(app, t.location_id, { section_id: existing.id, section_name: existing.name });
        state.sync_token = undefined;
        continue;
      }
      const ref = randomUUID();
      cmds.push(command('section_add', { name: t.name.slice(0, 120), project_id: homeRef }, ref));
      planned.push({ t, ref });
    }
  }
  const renamed = renames.map((t) => ({ t, c: command('section_update', { id: t.section_id, name: t.name.slice(0, 120) }) }));
  cmds.push(...renamed.map((r) => r.c));
  // the auto project got a new name in the settings: rename it instead of creating another one
  const renameHome = !cfg.home_project_id && !newHome && state.parent_project_id && state.parent_project_name && state.parent_project_name !== homeName(cfg) ? command('project_update', { id: state.parent_project_id, name: homeName(cfg) }) : null;
  if (renameHome) cmds.push(renameHome);
  if (!cmds.length) return;
  const { status, tempIds } = await create(app, client, state, cmds, counts);
  if (newHome && tempIds[newHome]) {
    Object.assign(state, { parent_project_id: tempIds[newHome], parent_project_name: homeName(cfg) });
    log(app, 'info', `Todoist-Projekt „${homeName(cfg)}“ angelegt.`);
  }
  if (renameHome && status[renameHome.uuid] === 'ok') state.parent_project_name = homeName(cfg);
  const made = planned.filter(({ t, ref }) => tempIds[ref] && (setMapping(app, t.location_id, { section_id: tempIds[ref], section_name: t.name }), true));
  if (made.length) log(app, 'info', `${made.length === 1 ? 'Abschnitt' : `${made.length} Abschnitte`} in „${homeName(cfg)}“ angelegt: ${made.map(({ t }) => t.name).join(', ')}.`);
  for (const { t, c } of renamed) if (status[c.uuid] === 'ok') setMapping(app, t.location_id, { section_name: t.name });
}

// --- push -----------------------------------------------------------------------------------

/** What would the next push send? Also notes when a local change was first seen (conflict timing). */
export function pendingWork(app: App, cfg = getConfig(app), state = getState(app)) {
  const { db } = app;
  const active = targets(app, cfg, state).filter((t) => t.mode !== 'off');
  const locs = active.map((t) => t.location_id);
  if (!locs.length) return { deletes: [] as Row[], updates: [] as Row[], creates: [] as Row[], retries: [] as Row[] };
  const inLocs = `(${locs.map(() => '?').join(',')})`;
  const deletes = db.all(`SELECT l.* FROM todoist_links l LEFT JOIN tasks t ON t.id = l.task_id WHERE t.id IS NULL AND l.status = 'active' AND l.todoist_id IS NOT NULL AND l.location_id IN ${inLocs}`, ...locs);
  db.run(`DELETE FROM todoist_links WHERE status = 'pending' AND task_id NOT IN (SELECT id FROM tasks)`);
  const updates = db
    .all(`SELECT l.*, t.title, t.description, t.due_at, t.done, t.contact_id FROM todoist_links l JOIN tasks t ON t.id = l.task_id WHERE l.status = 'active' AND l.todoist_id IS NOT NULL AND l.fail_count < 5 AND l.location_id IN ${inLocs}`, ...locs)
    .filter((r) => hashFields(localFields(r)) !== r.local_hash || !!r.done !== !!r.synced_done);
  const stamp = now();
  for (const r of updates) if (!r.local_changed_at) db.run('UPDATE todoist_links SET local_changed_at = ? WHERE task_id = ?', (r.local_changed_at = stamp), r.task_id);
  if (limitBlocked(state)) return { deletes, updates, creates: [] as Row[], retries: [] as Row[] }; // nothing new until the limit is sorted out
  const readyLocs = active.filter((t) => t.ready).map((t) => t.location_id);
  const creates = readyLocs.length
    ? db.all(
        `SELECT t.* FROM tasks t LEFT JOIN todoist_links l ON l.task_id = t.id WHERE l.task_id IS NULL AND t.done = 0 AND t.location_id IN (${readyLocs.map(() => '?').join(',')})
         ${cfg.scope === 'mine' ? 'AND t.assigned_to = ?' : ''} ORDER BY t.created_at LIMIT 500`,
        ...readyLocs, ...(cfg.scope === 'mine' ? [cfg.owner_user_id ?? ''] : []),
      )
    : [];
  const retries = db.all(`SELECT l.*, t.title, t.description, t.due_at, t.contact_id FROM todoist_links l JOIN tasks t ON t.id = l.task_id WHERE l.status = 'pending' AND l.fail_count < 5 AND l.location_id IN ${inLocs}`, ...locs);
  return { deletes, updates, creates, retries };
}

export function needsPush(app: App): boolean {
  const w = pendingWork(app);
  return !!(w.deletes.length || w.updates.length || w.creates.length || w.retries.length);
}

async function push(app: App, client: TodoistClient, cfg: TodoistConfig, state: TodoistState, counts: RunCounts) {
  const { db } = app;
  const all = new Map(targets(app, cfg, state).map((t) => [t.location_id, t]));
  const work = pendingWork(app, cfg, state);
  const cmds: Command[] = [];
  const after: ((status: Record<string, CommandStatus>, tempIds: Record<string, string>) => void)[] = [];
  const tz = (locationId: string) => all.get(locationId)?.timezone || 'Europe/Berlin';
  const gone = new Set<string>();
  const lostContainer = (locationId: string) => {
    const t = all.get(locationId);
    if (!t || gone.has(locationId)) return;
    gone.add(locationId);
    if (cfg.layout === 'sections') sectionGone(app, t, counts);
    else projectGone(app, t, counts);
  };
  const fail = (link: Row, s: CommandStatus | undefined, what: string) => {
    const msg = `${what} „${link.title ?? link.task_id}“ fehlgeschlagen: ${commandError(s)}`;
    db.run('UPDATE todoist_links SET fail_count = fail_count + 1, last_error = ? WHERE task_id = ?', msg, link.task_id);
    log(app, 'error', msg, { task_id: link.task_id, todoist_id: link.todoist_id });
    counts.errors++;
  };

  // 1. deleted here → delete there (with a safety stop for mass deletions)
  const activeLinks = Number(db.get(`SELECT COUNT(*) AS n FROM todoist_links WHERE status = 'active'`)?.n ?? 0);
  if (work.deletes.length > MASS_DELETE && work.deletes.length > activeLinks / 2) {
    db.run(`UPDATE todoist_links SET status = 'orphaned' WHERE task_id IN (${work.deletes.map(() => '?').join(',')})`, ...work.deletes.map((l) => l.task_id));
    log(app, 'error', `Sicherheitsstopp: ${work.deletes.length} von ${activeLinks} verknüpften Aufgaben fehlen hier auf einmal – sie werden in Todoist NICHT gelöscht, nur abgekoppelt.`);
    counts.errors++;
  } else {
    for (const link of work.deletes) {
      const c = command('item_delete', { id: link.todoist_id });
      cmds.push(c);
      after.push((st) => {
        if (st[c.uuid] === undefined) return; // batch not sent – next run
        if (st[c.uuid] === 'ok' || isGone(st[c.uuid])) {
          db.run('DELETE FROM todoist_links WHERE task_id = ?', link.task_id);
          counts.deleted++;
        } else fail(link, st[c.uuid], 'Löschen von');
      });
    }
  }

  // 2. changed here → update / close / reopen there
  for (const r of work.updates) {
    const f = localFields(r);
    const h = hashFields(f);
    const fieldsChanged = h !== r.local_hash;
    const doneChanged = !!r.done !== !!r.synced_done;
    const mine: Command[] = [];
    if (doneChanged && !r.done) mine.push(command('item_uncomplete', { id: r.todoist_id }));
    if (fieldsChanged) mine.push(command('item_update', { id: r.todoist_id, content: f.title || 'Aufgabe', description: withFooter(f.description, taskUrl(app, r)), due: toTodoistDue(f.due, tz(r.location_id)) }));
    if (doneChanged && r.done) mine.push(command('item_close', { id: r.todoist_id }));
    cmds.push(...mine);
    after.push((st) => {
      if (mine.some((c) => st[c.uuid] === undefined)) return; // batch not sent – next run
      if (mine.every((c) => st[c.uuid] === 'ok')) {
        db.run('UPDATE todoist_links SET local_hash = ?, remote_hash = ?, synced_done = ?, local_changed_at = NULL, synced_at = ?, fail_count = 0, last_error = NULL WHERE task_id = ?', h, h, r.done ? 1 : 0, now(), r.task_id);
        counts.pushed++;
        return;
      }
      if (mine.some((c) => isGone(st[c.uuid]))) {
        const task = db.get('SELECT * FROM tasks WHERE id = ?', r.task_id);
        if (task) remoteDeleted(app, cfg, r, task, counts);
      } else fail(r, st[mine.find((c) => st[c.uuid] !== 'ok')!.uuid], 'Abgleich von');
    });
  }

  // 3. new here (or a create to retry with the same uuid) → add there
  const addCommand = (t: Row, projectId: string, sectionId: string | null, uuid: string, tempId: string): Command => ({
    type: 'item_add',
    uuid,
    temp_id: tempId,
    args: {
      content: localFields(t).title || 'Aufgabe',
      description: withFooter(localFields(t).description, taskUrl(app, t)),
      project_id: projectId,
      ...(sectionId ? { section_id: sectionId } : {}),
      due: toTodoistDue(localFields(t).due, tz(t.location_id)),
      ...(cfg.label ? { labels: [LABEL] } : {}),
    },
  });
  const sent: { t: Row; c: Command; locationId: string }[] = [];
  for (const t of work.creates) {
    const target = all.get(t.location_id)!;
    const c = addCommand(t, target.project_id!, target.section_id, randomUUID(), randomUUID());
    // the link row exists before the request: a crash or timeout retries with the same uuid
    db.insert('todoist_links', { task_id: t.id, todoist_id: null, location_id: t.location_id, project_id: target.project_id, section_id: target.section_id, status: 'pending', pending_uuid: c.uuid, pending_temp_id: c.temp_id, synced_done: 0, created_at: now() });
    sent.push({ t, c, locationId: t.location_id });
  }
  for (const r of work.retries) {
    if (!r.project_id) continue;
    sent.push({ t: { ...r, id: r.task_id }, c: addCommand({ ...r, id: r.task_id }, r.project_id, r.section_id ?? null, r.pending_uuid, r.pending_temp_id), locationId: r.location_id });
  }
  for (const { t, c, locationId } of sent) {
    cmds.push(c);
    after.push((st, tempIds) => {
      const s = st[c.uuid];
      if (s === undefined) return; // batch not sent – retried with the same uuid
      const todoistId = tempIds[c.temp_id!];
      if (s === 'ok' && todoistId) {
        const h = hashFields(localFields(t));
        db.run(`UPDATE todoist_links SET todoist_id = ?, status = 'active', local_hash = ?, remote_hash = ?, synced_done = 0, synced_at = ?, pending_uuid = NULL, pending_temp_id = NULL, fail_count = 0, last_error = NULL WHERE task_id = ?`, todoistId, h, h, now(), t.id);
        counts.created++;
      } else if (s === 'ok') {
        // already executed earlier (same uuid): the next read adopts the task by title
      } else if (isLimit(s)) {
        // not created: forget the pending row, the task goes out once the limit is sorted out
        db.run(`DELETE FROM todoist_links WHERE task_id = ? AND status = 'pending'`, t.id);
        if (!state.limit_error) hitLimit(state, `Aufgabe „${localFields(t).title}“ konnte nicht angelegt werden`, s, counts);
      } else if (s.error_tag === 'PROJECT_NOT_FOUND' || s.error_tag === 'SECTION_NOT_FOUND') {
        lostContainer(locationId);
      } else fail({ ...t, task_id: t.id }, s, 'Anlegen von');
    });
  }

  if (!cmds.length) return;
  const { status, tempIds, error } = await client.commands(cmds);
  db.tx(() => {
    for (const fn of after) fn(status, tempIds);
  });
  if (error) throw error;
}
