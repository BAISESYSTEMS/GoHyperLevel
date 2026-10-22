import type { App } from '../core/app.js';
import { id, normalizeEmail, now, slugify, token } from '../core/util.js';
import type { RAppointment, RCalendar, RSubmission } from './umzug-core.js';
import type { ExtraEnv, Host, UndoHelpers } from './umzug-extra.js';
import { clip } from './umzug-text.js';

/**
 * Calendars, appointments and form answers of the switch-over importers (Calendly, Typeform), written straight into the tables:
 * no confirmation mail, no reminder, no workflow event, no team notification – an import must never contact anybody. Calendars
 * are saved INACTIVE (no public booking page opens by itself) and without messages. A row a person has changed since the import stays
 * as they left it (a fingerprint of what was written is kept in the id map).
 */

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hhmm = /^\d\d:\d\d$/;
const iso = (v?: string): string | undefined => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const fp = (...v: unknown[]) => JSON.stringify(v);

export class BookingWriter {
  private readonly db: App['db'];
  private readonly loc: string;
  private there: { calendars?: boolean; forms?: boolean } = {};
  private readonly told = new Set<string>();

  constructor(
    private env: ExtraEnv,
    private host: Host,
  ) {
    this.db = env.app.db;
    this.loc = env.locationId;
  }

  private has(table: 'calendars' | 'forms'): boolean {
    return (this.there[table] ??= !!this.db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table === 'calendars' ? 'appointments' : 'form_submissions'));
  }

  private tell(key: string, m: string) {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.env.warn(m);
  }

  /** The contact of an ext id, else an existing contact with that e-mail (nobody is created here). */
  private contact(ext?: string, email?: string): string | null {
    const local = this.host.contactLocal(ext);
    if (local && !local.startsWith('dry:')) return local;
    if (email) return this.db.get<{ id: string }>('SELECT id FROM contacts WHERE location_id = ? AND email = ?', this.loc, normalizeEmail(email))?.id ?? null;
    return null;
  }

  // --- calendars ------------------------------------------------------------------------------------------------------

  calendar(rec: RCalendar) {
    const known = this.host.getId('calendar', rec.ext);
    if (this.env.dry) {
      this.host.stat('calendars', known ? 'updated' : 'created');
      return void this.host.virtual.add(`calendar:${rec.ext}`);
    }
    if (!this.has('calendars')) {
      this.host.stat('calendars', 'skipped');
      return void this.tell('nocal', `Kalender „${clip(rec.name, 60)}“ nicht angelegt: die Terminbuchung ist in dieser Installation nicht verfügbar`);
    }
    const availability: Record<string, [string, string][]> = {};
    for (const d of DAYS) {
      const w = (rec.availability?.[d] ?? []).filter((x) => hhmm.test(x[0]) && hhmm.test(x[1]) && x[0] < x[1]);
      if (w.length) availability[d] = w.map((x) => [x[0], x[1]]);
    }
    const today = new Date().toISOString().slice(0, 10);
    const overrides = Object.fromEntries(Object.entries(rec.date_overrides ?? {}).filter(([d, w]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && Array.isArray(w)).slice(0, 200).map(([d, w]) => [d, w.filter((x) => hhmm.test(x[0]) && hhmm.test(x[1]) && x[0] < x[1])]));
    const duration = Math.max(5, Math.min(1440, Math.round(rec.duration) || 30));
    const color = rec.color && /^#[0-9a-f]{6}$/i.test(rec.color) ? rec.color : '#2563eb';
    const row = { name: clip(rec.name, 120).trim() || 'Termin', description: clip(rec.description, 2000), duration, availability: JSON.stringify(availability), timezone: rec.timezone || 'Europe/Berlin', color };
    const have = known ? this.db.get<any>('SELECT * FROM calendars WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    const print = (r: any) => fp(r.name, r.description, r.duration, r.availability, r.timezone, r.color, r.active);
    if (have) {
      if (known!.extra && print(have) !== known!.extra) {
        this.host.stat('calendars', 'skipped');
        return;
      }
      this.db.update('calendars', have.id, row, this.loc);
      this.host.setId('calendar', rec.ext, have.id, print(this.db.get('SELECT * FROM calendars WHERE id = ?', have.id)));
      this.host.stat('calendars', 'updated');
      return;
    }
    const base = slugify(row.name).slice(0, 50) || 'termin';
    let slug = base;
    // Slugs are unique across the whole installation (they are part of the public booking address).
    for (let i = 2; this.db.get('SELECT 1 FROM calendars WHERE slug = ?', slug); i++) slug = `${base}-${i}`;
    const cid = id();
    this.db.insert('calendars', {
      id: cid,
      location_id: this.loc,
      slug,
      interval: Math.min(duration, 60),
      buffer: 0,
      min_notice: 4,
      max_days: 60,
      active: 0,
      settings: { confirmation_email: false, notify_team: false, reminder_hours: 0, meeting_location: clip(rec.location, 300), tags: [], ask_phone: true, ask_notes: true, ...(Object.keys(overrides).length ? { date_overrides: overrides } : {}), umzug: { source: this.env.source, note: `Aus ${this.env.label} übernommen – prüfen und aktivieren` } },
      external_id: null,
      created_at: now(),
      ...row,
    });
    this.host.setId('calendar', rec.ext, cid, print(this.db.get('SELECT * FROM calendars WHERE id = ?', cid)));
    this.host.item('calendar', cid, rec.ext, true);
    this.host.stat('calendars', 'created');
  }

  // --- appointments ---------------------------------------------------------------------------------------------------

  appointment(rec: RAppointment) {
    const known = this.host.getId('appointment', rec.ext);
    if (this.env.dry) {
      this.host.stat('appointments', known ? 'updated' : 'created');
      return void this.host.virtual.add(`appointment:${rec.ext}`);
    }
    const cal = this.host.getId('calendar', rec.calendar);
    if (!this.has('calendars') || !cal || cal.local.startsWith('dry:') || !this.db.get('SELECT 1 FROM calendars WHERE id = ? AND location_id = ?', cal.local, this.loc)) {
      this.host.stat('appointments', 'skipped');
      return void this.tell(`nocal:${rec.calendar}`, `Termine übersprungen: der Kalender „${clip(rec.calendar, 40)}“ ist nicht angelegt`);
    }
    const start = iso(rec.start_at);
    const end = iso(rec.end_at) ?? start;
    if (!start || !end) {
      this.host.stat('appointments', 'skipped');
      return;
    }
    const contact = this.contact(rec.contact, rec.contact_hint?.email);
    const row = { calendar_id: cal.local, contact_id: contact, title: clip(rec.title, 300).trim() || 'Termin', start_at: start, end_at: end, status: rec.status === 'cancelled' ? 'cancelled' : 'confirmed', notes: clip(rec.notes, 5000) };
    const print = (r: any) => fp(r.calendar_id, r.contact_id, r.title, r.start_at, r.end_at, r.status, r.notes);
    const have = known ? this.db.get<any>('SELECT * FROM appointments WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    if (have) {
      if (known!.extra && print(have) !== known!.extra) {
        this.host.stat('appointments', 'skipped');
        return;
      }
      this.db.update('appointments', have.id, row, this.loc);
      this.host.setId('appointment', rec.ext, have.id, print(this.db.get('SELECT * FROM appointments WHERE id = ?', have.id)));
      this.host.stat('appointments', 'updated');
      return;
    }
    const aid = id();
    this.db.insert('appointments', { id: aid, location_id: this.loc, manage_token: token(18), reminder_sent: 1, reminders_sent: '{}', external_id: null, source: clip(`Import: ${this.env.label}`, 60), created_at: iso(rec.created_at) ?? now(), ...row });
    this.host.setId('appointment', rec.ext, aid, print(this.db.get('SELECT * FROM appointments WHERE id = ?', aid)));
    this.host.item('appointment', aid, rec.ext, true);
    this.host.stat('appointments', 'created');
  }

  // --- form answers ---------------------------------------------------------------------------------------------------

  submission(rec: RSubmission) {
    const known = this.host.getId('submission', rec.ext);
    if (this.env.dry) {
      this.host.stat('submissions', known ? 'updated' : 'created');
      return void this.host.virtual.add(`submission:${rec.ext}`);
    }
    const form = this.host.getId('form', rec.form);
    if (!this.has('forms') || !form || form.local.startsWith('dry:') || !this.db.get('SELECT 1 FROM forms WHERE id = ? AND location_id = ?', form.local, this.loc)) {
      this.host.stat('submissions', 'skipped');
      return void this.tell(`noform:${rec.form}`, `Antworten übersprungen: das Formular „${clip(rec.form, 40)}“ ist nicht angelegt (Teil „Formulare“ mitnehmen)`);
    }
    const have = known ? this.db.get<{ id: string; contact_id: string | null }>('SELECT id, contact_id FROM form_submissions WHERE id = ? AND location_id = ?', known.local, this.loc) : undefined;
    if (have) {
      // An answer sheet does not change at the old tool either – only a contact that has come to exist since is linked.
      if (!have.contact_id) {
        const c = this.contact(rec.contact, rec.contact_hint?.email);
        if (c) this.db.update('form_submissions', have.id, { contact_id: c }, this.loc);
      }
      return void this.host.stat('submissions', 'updated');
    }
    const answers: Record<string, string | string[]> = {};
    for (const [q, a] of Object.entries(rec.answers)) {
      const v = Array.isArray(a) ? a.map((x) => clip(x, 10_000)) : clip(a, 10_000);
      if (v !== '' && !(Array.isArray(v) && !v.length)) answers[clip(q, 300) || 'Antwort'] = v;
    }
    const sid = id();
    this.db.insert('form_submissions', { id: sid, location_id: this.loc, form_id: form.local, contact_id: this.contact(rec.contact, rec.contact_hint?.email), data: answers, meta: { ...rec.meta, import: this.env.label }, created_at: iso(rec.at) ?? now() });
    this.host.setId('submission', rec.ext, sid);
    this.host.item('form_submission', sid, rec.ext, true);
    this.host.stat('submissions', 'created');
  }
}

// --- undo ---------------------------------------------------------------------------------------------------------

type Item = { kind: string; local_id: string; ext_id: string; created: number };

/** Answer sheets go before the forms (a form takes its answers along when it is deleted, which would hide them from the count). */
export function undoSubmissions(app: App, loc: string, items: Item[], h: Pick<UndoHelpers, 'del'>) {
  for (const it of items.filter((i) => i.kind === 'form_submission' && i.created)) {
    try {
      if (app.db.run('DELETE FROM form_submissions WHERE id = ? AND location_id = ?', it.local_id, loc).changes) h.del('submissions');
    } catch {
      /* forms not installed */
    }
  }
}

/** Appointments first, then the calendars nobody booked into since. */
export function undoBooking(app: App, loc: string, items: Item[], h: UndoHelpers) {
  const db = app.db;
  for (const it of items.filter((i) => i.kind === 'appointment' && i.created)) {
    try {
      if (db.run('DELETE FROM appointments WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('appointments'), h.gone.push(it.local_id));
    } catch {
      /* calendars not installed */
    }
  }
  for (const it of items.filter((i) => i.kind === 'calendar' && i.created)) {
    try {
      if (!db.get('SELECT 1 FROM calendars WHERE id = ? AND location_id = ?', it.local_id, loc)) continue;
      if (db.get('SELECT 1 FROM appointments WHERE calendar_id = ? LIMIT 1', it.local_id)) {
        h.keep('calendars');
        h.notes.push('Ein Kalender bleibt, weil darin Termine liegen, die nicht aus dem Umzug stammen.');
        continue;
      }
      if (db.run('DELETE FROM calendars WHERE id = ? AND location_id = ?', it.local_id, loc).changes) (h.del('calendars'), h.gone.push(it.local_id));
    } catch {
      /* calendars not installed */
    }
  }
}
