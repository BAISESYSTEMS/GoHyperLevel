import type { Module } from '../core/app.js';

/**
 * Indexes for the queries that run on every page view or across all sub-accounts (dashboard, agency
 * overview, project cards, mobile summary, task/deal/contact lists). Without them SQLite scans a whole
 * table per sub-account: 50 sub-accounts with 200k messages made `/api/agency/projects` take 1.6 s.
 *
 * Kept in one module that comes late in the registry, so every table already exists. Migration names
 * never change once shipped; later additions get a new name.
 */
export const perfIndexesModule: Module = {
  name: 'perf-indexes',
  migrations: [
    [
      '001-core-indexes',
      `
      -- tasks: the sub-account's list (open first, by due date), counters (done first: "open tasks per
      -- sub-account" is then one ordered range), the agency-wide list
      CREATE INDEX IF NOT EXISTS ix_tasks_loc_open ON tasks(location_id, done, COALESCE(due_at, '9999'), created_at);
      CREATE INDEX IF NOT EXISTS ix_tasks_done_loc ON tasks(done, location_id, due_at);
      CREATE INDEX IF NOT EXISTS ix_tasks_open_due ON tasks(done, COALESCE(due_at, '9999'), created_at);
      CREATE INDEX IF NOT EXISTS ix_tasks_contact ON tasks(contact_id);
      -- contact timeline: "last activity" per sub-account
      CREATE INDEX IF NOT EXISTS ix_activities_loc ON activities(location_id, created_at);
      -- deals: counters by status (value last, so sums are answered from the index), newest first
      CREATE INDEX IF NOT EXISTS ix_opps_loc_status ON opportunities(location_id, status, updated_at DESC, value);
      CREATE INDEX IF NOT EXISTS ix_opps_loc_updated ON opportunities(location_id, updated_at DESC);
      -- inbox: conversation list by last message, unread counters, drafts, sent/received per period
      CREATE INDEX IF NOT EXISTS ix_conv_loc_last ON conversations(location_id, last_message_at);
      CREATE INDEX IF NOT EXISTS ix_conv_unread ON conversations(location_id) WHERE unread > 0;
      CREATE INDEX IF NOT EXISTS ix_messages_loc_dir ON messages(location_id, direction, created_at);
      CREATE INDEX IF NOT EXISTS ix_messages_drafts ON messages(location_id) WHERE status = 'draft';
      -- invoices: list per kind, revenue by status and payment date
      CREATE INDEX IF NOT EXISTS ix_invoices_loc_kind ON invoices(location_id, kind, created_at);
      CREATE INDEX IF NOT EXISTS ix_invoices_loc_status ON invoices(location_id, status, paid_at);
      -- contacts: sort by last activity (per sub-account and across all), as the lists do
      CREATE INDEX IF NOT EXISTS ix_contacts_loc_activity ON contacts(location_id, last_activity_at);
      CREATE INDEX IF NOT EXISTS ix_contacts_recent ON contacts(COALESCE(last_activity_at, created_at) DESC);
      -- background jobs that follow contacts.updated_at with a cursor (companies catch-up)
      CREATE INDEX IF NOT EXISTS ix_contacts_updated ON contacts(updated_at);
      -- small tables the overview counts per sub-account
      CREATE INDEX IF NOT EXISTS ix_appointments_loc ON appointments(location_id, start_at);
      CREATE INDEX IF NOT EXISTS ix_form_submissions_loc ON form_submissions(location_id, created_at);
      CREATE INDEX IF NOT EXISTS ix_funnels_loc ON funnels(location_id);
      CREATE INDEX IF NOT EXISTS ix_funnel_pages_loc ON funnel_pages(location_id);
      CREATE INDEX IF NOT EXISTS ix_notes_contact ON notes(contact_id, created_at);
      CREATE INDEX IF NOT EXISTS ix_review_requests_loc ON review_requests(location_id);
      CREATE INDEX IF NOT EXISTS ix_pipelines_loc ON pipelines(location_id);
      CREATE INDEX IF NOT EXISTS ix_locations_name ON locations(name);
      `,
    ],
    [
      '002-job-indexes',
      `
      -- Housekeeping jobs delete "everything older than N days" across all sub-accounts every hour; the log tables only had
      -- per-sub-account indexes, so each run read the whole table (measured: 2 M rows of e-mail events = 236 ms, now 0.2 ms).
      CREATE INDEX IF NOT EXISTS ix_email_events_at ON email_events(at);
      CREATE INDEX IF NOT EXISTS ix_tracked_links_created ON tracked_links(created_at);
      CREATE INDEX IF NOT EXISTS ix_form_events_at ON form_events(at);
      CREATE INDEX IF NOT EXISTS ix_dni_sessions_seen ON dni_sessions(last_seen_at);
      CREATE INDEX IF NOT EXISTS ix_voice_turns_at ON voice_turns(at);
      CREATE INDEX IF NOT EXISTS ix_inbox_response_responded ON inbox_response_log(responded_at);
      CREATE INDEX IF NOT EXISTS ix_community_notifications_created ON community_notifications(created_at);
      CREATE INDEX IF NOT EXISTS ix_composio_events_created ON composio_events(created_at);
      CREATE INDEX IF NOT EXISTS ix_composio_calls_created ON composio_calls(created_at);
      CREATE INDEX IF NOT EXISTS ix_plugin_events_created ON plugin_events(created_at);
      -- Ticks that run every 15 seconds and used to read every invoice / every ticket: recurring invoices, tickets with a running
      -- SLA clock, survey reminders that are due.
      CREATE INDEX IF NOT EXISTS ix_invoices_recurring ON invoices(location_id) WHERE recurring IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_tickets_running ON tickets(location_id) WHERE merged_into IS NULL AND status_kind IN ('new','open','waiting');
      CREATE INDEX IF NOT EXISTS ix_tickets_csat_due ON tickets(csat_due_at) WHERE csat_due_at IS NOT NULL;
      `,
    ],
  ],
  register() {
    /* only indexes */
  },
};
