import type { Module } from '../core/app.js';
import { parseRows } from '../core/db.js';
import { addDaysYmd, zonedToUtc } from '../core/time.js';
import { dueDays } from '../services/wfx-triggers.js';
import { contactDate, inYear, processRun, startWorkflow } from '../services/workflow-engine.js';

/**
 * Workflow trigger „Datum erreicht“: starts a workflow on (or N days before/after) a date stored on
 * the contact, e.g. the birthday every year or a contract end date once. A day the server missed (off at
 * the set time) is caught up later, at most three days back – see dueDays in services/wfx-triggers.ts.
 */

/** The occurrence (YYYY-MM-DD) that falls on `today`, or null. */
export function occurrenceToday(base: string, offsetDays: number, yearly: boolean, today: string): string | null {
  if (!yearly) return addDaysYmd(base, offsetDays) === today ? base : null;
  const year = Number(today.slice(0, 4));
  for (const y of [year - 1, year, year + 1]) {
    const occ = inYear(base, y);
    if (addDaysYmd(occ, offsetDays) === today) return occ;
  }
  return null;
}

export async function runDateTriggers(app: Parameters<Module['register']>[0], at = new Date()) {
  const flows = parseRows(app.db.all(`SELECT * FROM workflows WHERE status = 'active' AND json_extract(trigger, '$.type') = 'date.reached'`), ['steps', 'trigger', 'settings']);
  let started = 0;
  for (const wf of flows) {
    const c = wf.trigger.config ?? {};
    const field = String(c.field || 'date_of_birth');
    const loc = app.location(wf.location_id);
    if (!loc) continue;
    const tz = loc.timezone || 'Europe/Berlin';
    const time = /^\d{2}:\d{2}$/.test(c.time ?? '') ? c.time : '09:00';
    const seen = app.db.get<{ at: string }>('SELECT at FROM date_trigger_seen WHERE workflow_id = ?', wf.id)?.at;
    const days = dueDays(at, tz, time, seen, wf.updated_at);
    const yearly = c.yearly ?? field === 'date_of_birth';
    const key = field.startsWith('custom.') ? field.slice(7) : null;
    const contacts =
      !days.length || (key ? !/^\w+$/.test(key) : field !== 'date_of_birth')
        ? []
        : parseRows(
            key
              ? app.db.all(`SELECT * FROM contacts WHERE location_id = ? AND COALESCE(json_extract(custom, ?), '') != ''`, wf.location_id, `$.${key}`)
              : app.db.all(`SELECT * FROM contacts WHERE location_id = ? AND COALESCE(date_of_birth, '') != ''`, wf.location_id),
            ['tags', 'custom'],
          );
    for (const { day, late } of days) {
      // a day caught up late only counts for contacts that existed on it
      const due = late ? zonedToUtc(day, time, tz).toISOString() : '';
      for (const contact of contacts) {
        if (late && String(contact.created_at) > due) continue;
        const base = contactDate(contact, field);
        const occ = base && occurrenceToday(base, Number(c.offset_days) || 0, !!yearly, day);
        if (!occ) continue;
        // one run per contact and occurrence (the date in its year) – also when a day is caught up
        const fresh = app.db.run('INSERT OR IGNORE INTO date_trigger_fires (workflow_id, contact_id, occurrence, created_at) VALUES (?, ?, ?, ?)', wf.id, contact.id, occ, at.toISOString()).changes;
        if (!fresh) continue;
        // Yearly triggers must be able to start again next year.
        const rid = startWorkflow(app, yearly ? { ...wf, settings: { ...wf.settings, allow_reentry: true } } : wf, contact.id, { date: occ, field, ...(late ? { late_days: late } : {}) });
        if (rid) {
          started++;
          await processRun(app, rid);
        }
      }
    }
    app.db.run('INSERT INTO date_trigger_seen (workflow_id, at) VALUES (?, ?) ON CONFLICT(workflow_id) DO UPDATE SET at = excluded.at', wf.id, at.toISOString());
  }
  return started;
}

export const dateTriggersModule: Module = {
  name: 'date-triggers',
  migrations: [
    [
      '001-init',
      `CREATE TABLE date_trigger_fires (
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        occurrence TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workflow_id, contact_id, occurrence)
      );`,
    ],
    [
      // when each workflow was last looked at: the days in between whose time passed (server off) are caught up
      '002-seen',
      `CREATE TABLE date_trigger_seen (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE, at TEXT NOT NULL
      );`,
    ],
  ],
  register(app) {
    let last = 0;
    let pruned = 0;
    app.onTick(async () => {
      if (Date.now() - last < 5 * 6e4) return;
      last = Date.now();
      await runDateTriggers(app);
      // A run per contact and occurrence is remembered only for catching up missed days (at most three back); a year's worth is
      // plenty – without this the table grew by one row per contact, workflow and year for ever.
      if (Date.now() - pruned > 864e5) {
        pruned = Date.now();
        app.db.run('DELETE FROM date_trigger_fires WHERE created_at < ?', new Date(Date.now() - 400 * 864e5).toISOString());
      }
    });
  },
};
