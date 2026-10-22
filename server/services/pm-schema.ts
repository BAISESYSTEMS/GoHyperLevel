/**
 * Tables of the project planning feature (module `pm`) and the extension of the existing `tasks` table.
 * Migrations are never edited once shipped – new ones are appended in modules/pm.ts.
 */

/** Statuses every project starts with (kept in step with DEFAULT_STATUSES in pm-core.ts). */
const DEFAULT_STATUS_ROWS = `SELECT 'Offen' AS name, 'todo' AS category, '#94a3b8' AS color, 0 AS position
  UNION ALL SELECT 'In Arbeit', 'active', '#3b82f6', 1
  UNION ALL SELECT 'In Prüfung', 'active', '#f59e0b', 2
  UNION ALL SELECT 'Erledigt', 'done', '#10b981', 3`;

export const PM_INIT = `
CREATE TABLE pm_projects (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT '#2563eb',
  status TEXT NOT NULL DEFAULT 'active',
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  opportunity_id TEXT REFERENCES opportunities(id) ON DELETE SET NULL,
  owner_id TEXT, start_at TEXT, due_at TEXT,
  is_default INTEGER NOT NULL DEFAULT 0, portal_visible INTEGER NOT NULL DEFAULT 0,
  billable INTEGER NOT NULL DEFAULT 1, hourly_rate_cents INTEGER, skip_weekends INTEGER NOT NULL DEFAULT 0,
  template_key TEXT, baseline_at TEXT, position REAL NOT NULL DEFAULT 0, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_projects_loc ON pm_projects(location_id, status);
CREATE UNIQUE INDEX pm_projects_default ON pm_projects(location_id) WHERE is_default = 1;
CREATE INDEX pm_projects_contact ON pm_projects(contact_id);
CREATE INDEX pm_projects_company ON pm_projects(company_id);

CREATE TABLE pm_statuses (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'todo', color TEXT NOT NULL DEFAULT '#94a3b8', position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX pm_statuses_project ON pm_statuses(project_id, position);

CREATE TABLE pm_sections (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX pm_sections_project ON pm_sections(project_id, position);

CREATE TABLE pm_custom_fields (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', options TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX pm_custom_fields_loc ON pm_custom_fields(location_id, project_id);

-- the existing tasks table, extended: subtasks, project/section/status, planning dates, tags, checklists …
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES pm_projects(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN section_id TEXT REFERENCES pm_sections(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN status_id TEXT REFERENCES pm_statuses(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN start_at TEXT;
ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN position REAL NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN custom TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tasks ADD COLUMN checklists TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE tasks ADD COLUMN series_id TEXT;
ALTER TABLE tasks ADD COLUMN recurred_at TEXT;
ALTER TABLE tasks ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN milestone INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN baseline_start TEXT;
ALTER TABLE tasks ADD COLUMN baseline_end TEXT;
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
ALTER TABLE tasks ADD COLUMN created_by TEXT;
CREATE INDEX pm_tasks_loc_project ON tasks(location_id, project_id);
CREATE INDEX pm_tasks_project ON tasks(project_id, done, position);
CREATE INDEX pm_tasks_parent ON tasks(parent_id);
CREATE INDEX pm_tasks_status ON tasks(status_id, position);
CREATE INDEX pm_tasks_section ON tasks(section_id);
CREATE INDEX pm_tasks_series ON tasks(series_id);

CREATE TABLE pm_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX pm_assignees_user ON pm_assignees(user_id);
CREATE TABLE pm_watchers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, user_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX pm_watchers_user ON pm_watchers(user_id);

CREATE TABLE pm_dependencies (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'FS', lag INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  UNIQUE(task_id, depends_on)
);
CREATE INDEX pm_dependencies_on ON pm_dependencies(depends_on);
CREATE INDEX pm_dependencies_project ON pm_dependencies(project_id);

CREATE TABLE pm_comments (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT, author_name TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]',
  via TEXT, created_at TEXT NOT NULL, edited_at TEXT
);
CREATE INDEX pm_comments_task ON pm_comments(task_id, created_at);

CREATE TABLE pm_attachments (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'link', name TEXT NOT NULL, url TEXT, file TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX pm_attachments_task ON pm_attachments(task_id);

CREATE TABLE pm_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, project_id TEXT,
  user_id TEXT, user_name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX pm_activity_task ON pm_activity(task_id, id);

CREATE TABLE pm_settings (
  location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE, data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
);

CREATE TABLE pm_views (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE CASCADE, user_id TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'list', config TEXT NOT NULL DEFAULT '{}',
  shared INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_views_loc ON pm_views(location_id, project_id);

CREATE TABLE pm_templates (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'project', name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL
);
CREATE INDEX pm_templates_loc ON pm_templates(location_id, kind);

CREATE TABLE pm_automations (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{}', actions TEXT NOT NULL DEFAULT '[]',
  runs INTEGER NOT NULL DEFAULT 0, last_run_at TEXT, last_error TEXT, created_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX pm_automations_loc ON pm_automations(location_id, trigger, enabled);

CREATE TABLE pm_notifications (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, kind TEXT NOT NULL, task_id TEXT, project_id TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', ref TEXT,
  read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX pm_notifications_user ON pm_notifications(user_id, read_at, created_at);
CREATE UNIQUE INDEX pm_notifications_ref ON pm_notifications(user_id, ref) WHERE ref IS NOT NULL;

-- things already handled once (an overdue task is announced once per due date)
CREATE TABLE pm_seen (key TEXT PRIMARY KEY, at TEXT NOT NULL);

-- Tasks written by anything else (plain task list, workflows, Todoist, the app) join the default project and
-- keep status/done and the assignee list in step with the legacy columns.
CREATE TRIGGER pm_tasks_after_insert AFTER INSERT ON tasks
BEGIN
  UPDATE tasks SET project_id = (SELECT id FROM pm_projects WHERE location_id = NEW.location_id AND is_default = 1)
    WHERE id = NEW.id AND project_id IS NULL;
  UPDATE tasks SET status_id = (SELECT id FROM pm_statuses WHERE project_id = tasks.project_id AND category = CASE WHEN tasks.done = 1 THEN 'done' ELSE 'todo' END ORDER BY position LIMIT 1)
    WHERE id = NEW.id AND status_id IS NULL AND project_id IS NOT NULL;
  INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) SELECT NEW.id, NEW.assigned_to, NEW.created_at WHERE NEW.assigned_to IS NOT NULL;
END;
CREATE TRIGGER pm_tasks_done_changed AFTER UPDATE OF done ON tasks
WHEN NEW.done IS NOT OLD.done AND COALESCE((SELECT category = 'done' FROM pm_statuses WHERE id = NEW.status_id), -1) != NEW.done
BEGIN
  UPDATE tasks SET status_id = (SELECT id FROM pm_statuses WHERE project_id = NEW.project_id AND category = CASE WHEN NEW.done = 1 THEN 'done' ELSE 'todo' END ORDER BY position LIMIT 1)
    WHERE id = NEW.id AND NEW.project_id IS NOT NULL;
END;
CREATE TRIGGER pm_tasks_assignee_changed AFTER UPDATE OF assigned_to ON tasks
WHEN NEW.assigned_to IS NOT OLD.assigned_to
BEGIN
  DELETE FROM pm_assignees WHERE task_id = NEW.id AND user_id = OLD.assigned_to;
  INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) SELECT NEW.id, NEW.assigned_to, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE NEW.assigned_to IS NOT NULL;
END;

-- Existing tasks: one "Allgemein" project per sub-account (with the default statuses) takes them all.
INSERT INTO pm_projects (id, location_id, name, description, color, status, is_default, position, created_at, updated_at)
  SELECT lower(hex(randomblob(8))), l.id, 'Allgemein', 'Aufgaben ohne eigenes Projekt', '#64748b', 'active', 1, -1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM locations l;
INSERT INTO pm_statuses (id, location_id, project_id, name, category, color, position)
  SELECT lower(hex(randomblob(8))), p.location_id, p.id, s.name, s.category, s.color, s.position FROM pm_projects p CROSS JOIN (${DEFAULT_STATUS_ROWS}) s;
UPDATE tasks SET
  project_id = (SELECT id FROM pm_projects p WHERE p.location_id = tasks.location_id AND p.is_default = 1),
  status_id = (SELECT st.id FROM pm_statuses st JOIN pm_projects p ON p.id = st.project_id WHERE p.location_id = tasks.location_id AND p.is_default = 1 AND st.category = CASE WHEN tasks.done = 1 THEN 'done' ELSE 'todo' END ORDER BY st.position LIMIT 1),
  updated_at = COALESCE(completed_at, created_at);
INSERT OR IGNORE INTO pm_assignees (task_id, user_id, created_at) SELECT id, assigned_to, created_at FROM tasks WHERE assigned_to IS NOT NULL;
`;

export const PM_TIME = `
CREATE TABLE pm_time_entries (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, task_title TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES pm_projects(id) ON DELETE SET NULL,
  started_at TEXT NOT NULL, ended_at TEXT, seconds INTEGER NOT NULL DEFAULT 0,
  has_clock INTEGER NOT NULL DEFAULT 1, note TEXT NOT NULL DEFAULT '',
  billable INTEGER NOT NULL DEFAULT 1, rate_cents INTEGER, source TEXT NOT NULL DEFAULT 'timer',
  approval TEXT NOT NULL DEFAULT 'open',
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL, billed_rate_cents INTEGER, billed_seconds INTEGER, billed_at TEXT,
  auto_stopped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- one running timer per person, whatever the sub-account: enforced by the database itself
CREATE UNIQUE INDEX pm_time_running ON pm_time_entries(user_id) WHERE ended_at IS NULL;
CREATE INDEX pm_time_loc ON pm_time_entries(location_id, started_at);
CREATE INDEX pm_time_user ON pm_time_entries(user_id, started_at);
CREATE INDEX pm_time_task ON pm_time_entries(task_id);
CREATE INDEX pm_time_project ON pm_time_entries(project_id, started_at);
CREATE INDEX pm_time_invoice ON pm_time_entries(invoice_id);

CREATE TABLE pm_rates (
  id TEXT PRIMARY KEY, location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES pm_projects(id) ON DELETE CASCADE, user_id TEXT,
  rate_cents INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX pm_rates_scope ON pm_rates(location_id, COALESCE(project_id, ''), COALESCE(user_id, ''));

CREATE TABLE pm_timesheets (
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE, user_id TEXT NOT NULL, week TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted', submitted_at TEXT, decided_by TEXT, decided_at TEXT, note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (location_id, user_id, week)
);
`;
